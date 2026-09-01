import type { Readable } from 'node:stream';
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

/**
 * Backblaze B2, driven through its S3-compatible API. B2's `keyID` /
 * `applicationKey` map 1:1 onto the S3 `accessKeyId` / `secretAccessKey`, so we
 * reuse the AWS S3 v3 SDK and simply point it at B2's regional endpoint. The
 * connector never talks to Proxmox — it only knows this bucket and a local
 * (mounted) filesystem path.
 */
export interface B2Auth {
  keyId: string;
  applicationKey: string;
  /** e.g. https://s3.us-west-004.backblazeb2.com */
  endpoint: string;
  /** e.g. us-west-004 — derived from the endpoint when omitted. */
  region?: string;
}

export interface B2Bucket {
  name: string;
  createdAt?: Date;
}

export interface B2Object {
  /** Full object key (may include the configured prefix). */
  key: string;
  sizeBytes: number;
  lastModified?: Date;
  etag?: string;
}

export class B2ApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'B2ApiError';
  }
}

/** Pull the region out of a B2 S3 endpoint, e.g. https://s3.us-west-004.backblazeb2.com → us-west-004. */
export function regionFromEndpoint(endpoint: string): string {
  const m = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(endpoint || '');
  return m ? m[1] : 'us-west-004';
}

/** Map an S3/B2 SDK error to a short, human-readable message. */
function friendly(err: unknown): B2ApiError {
  const e = err as { name?: string; Code?: string; message?: string } | undefined;
  const code = e?.name || e?.Code || '';
  const msg = e?.message || String(err);
  const map: Record<string, string> = {
    InvalidAccessKeyId: 'The B2 keyID is not recognized. Check the Application Key ID.',
    SignatureDoesNotMatch: 'The B2 applicationKey is incorrect for this keyID.',
    AccessDenied: 'Access denied — this application key is not allowed on that bucket (check the key\'s bucket scope and capabilities).',
    Unauthorized: 'B2 rejected the credentials — check the keyID and applicationKey.',
    NoSuchBucket: 'That bucket does not exist (or this key cannot see it). Check the bucket name.',
    AllAccessDisabled: 'This B2 account or key is disabled.',
    ExpiredToken: 'The B2 credentials have expired — generate a new application key.',
  };
  if (map[code]) return new B2ApiError(map[code], code);
  if (/getaddrinfo ENOTFOUND|EAI_AGAIN|UnknownEndpoint/i.test(msg)) {
    return new B2ApiError('Could not resolve the B2 endpoint — check the endpoint URL and network connectivity.', code);
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENETUNREACH|TimeoutError|timed? ?out/i.test(msg)) {
    return new B2ApiError('Could not reach Backblaze B2 — the connection timed out or was refused.', code);
  }
  return new B2ApiError(msg || 'B2 request failed.', code);
}

export class B2Api {
  private _s3?: S3Client;

  constructor(private readonly auth: B2Auth) {}

  private get s3(): S3Client {
    if (!this._s3) {
      this._s3 = new S3Client({
        endpoint: this.auth.endpoint,
        region: this.auth.region || regionFromEndpoint(this.auth.endpoint),
        credentials: {
          accessKeyId: this.auth.keyId,
          secretAccessKey: this.auth.applicationKey,
        },
        // B2's S3 API requires path-style addressing.
        forcePathStyle: true,
        maxAttempts: 3,
      });
    }
    return this._s3;
  }

  /** List every bucket this key can see. */
  async listBuckets(): Promise<B2Bucket[]> {
    try {
      const r = await this.s3.send(new ListBucketsCommand({}));
      return (r.Buckets ?? []).map((b) => ({ name: b.Name ?? '', createdAt: b.CreationDate }));
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Confirm the bucket exists and is reachable with this key. */
  async headBucket(bucket: string): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (err) {
      throw friendly(err);
    }
  }

  /**
   * List all objects in a bucket (optionally under a prefix), following
   * pagination. Directory-placeholder keys (ending in "/") are skipped.
   */
  async listObjects(bucket: string, prefix?: string): Promise<B2Object[]> {
    try {
      const out: B2Object[] = [];
      let token: string | undefined;
      do {
        const r = await this.s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix || undefined,
            ContinuationToken: token,
            MaxKeys: 1000,
          }),
        );
        for (const o of r.Contents ?? []) {
          const key = o.Key ?? '';
          if (!key || key.endsWith('/')) continue;
          out.push({
            key,
            sizeBytes: o.Size ?? 0,
            lastModified: o.LastModified,
            etag: o.ETag?.replace(/"/g, ''),
          });
        }
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Size of a single object, or null if it doesn't exist. */
  async headObject(bucket: string, key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { sizeBytes: r.ContentLength ?? 0 };
    } catch (err) {
      const code = (err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } });
      if (code?.name === 'NotFound' || code?.Code === 'NoSuchKey' || code?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw friendly(err);
    }
  }

  /**
   * Multipart-upload a stream to the bucket. `size` scales the part size so even
   * a multi-hundred-GB backup stays under S3's 10,000-part limit. onProgress is
   * called with cumulative bytes as parts complete.
   */
  async uploadStream(
    bucket: string,
    key: string,
    body: Readable,
    size: number,
    onProgress?: (loaded: number) => void,
  ): Promise<void> {
    // Floor 64 MB; grow so we never exceed ~9,000 parts (headroom under the 10k cap).
    const partSize = Math.max(64 * 1024 * 1024, Math.ceil(size / 9000));
    try {
      const upload = new Upload({
        client: this.s3,
        params: { Bucket: bucket, Key: key, Body: body },
        partSize,
        queueSize: 4,
        leavePartsOnError: false,
      });
      if (onProgress) {
        upload.on('httpUploadProgress', (p) => {
          if (p.loaded != null) onProgress(p.loaded);
        });
      }
      await upload.done();
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Permanently delete a single object. On a versioned/lifecycle bucket, B2 applies its own retention. */
  async deleteObject(bucket: string, key: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Fetch an object's body as a Node stream, along with its size. */
  async getObjectStream(bucket: string, key: string): Promise<{ body: Readable; sizeBytes: number }> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!r.Body) throw new Error('B2 returned an empty response body.');
      return { body: r.Body as Readable, sizeBytes: r.ContentLength ?? 0 };
    } catch (err) {
      throw friendly(err);
    }
  }
}
