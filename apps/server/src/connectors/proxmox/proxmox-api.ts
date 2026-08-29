import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface ProxmoxAuth {
  baseUrl: string;
  /** e.g. "root@pam!cerebro" */
  tokenId: string;
  /** the token's secret UUID */
  tokenSecret: string;
  /** Verify the TLS certificate. Proxmox ships a self-signed cert, so this is usually false. */
  verifyTls: boolean;
}

export interface ProxmoxResource {
  id: string; // e.g. "qemu/100"
  type: 'qemu' | 'lxc' | string;
  vmid: number;
  node: string;
  name?: string;
  status?: string; // running | stopped
  maxmem?: number;
  mem?: number;
  maxcpu?: number;
  cpu?: number;
  uptime?: number;
}

export class ProxmoxApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Minimal Proxmox VE API client using API-token auth. No password/ticket/CSRF —
 * tokens are the recommended, least-privilege way to integrate.
 */
export class ProxmoxApi {
  constructor(private readonly auth: ProxmoxAuth) {}

  /** The user part of the token id, e.g. "root@pam" from "root@pam!cerebro". */
  get tokenUser(): string {
    return (this.auth.tokenId || '').split('!')[0];
  }

  private request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${this.auth.baseUrl.replace(/\/$/, '')}/api2/json${path}`);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    // Proxmox expects application/x-www-form-urlencoded bodies.
    let payload: string | undefined;
    const headers: Record<string, string> = {
      Authorization: `PVEAPIToken=${this.auth.tokenId}=${this.auth.tokenSecret}`,
      Accept: 'application/json',
    };
    if (body) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
      }
      payload = form.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }

    const options: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      // Proxmox default cert is self-signed; honor the operator's choice.
      rejectUnauthorized: isHttps ? this.auth.verifyTls : undefined,
      timeout: 20000,
    };

    return new Promise<T>((resolve, reject) => {
      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            return reject(new ProxmoxApiError('Authentication failed — check the token ID and secret, and its permissions.', status));
          }
          if (status < 200 || status >= 300) {
            return reject(new ProxmoxApiError(`Proxmox returned HTTP ${status}: ${body.slice(0, 200)}`, status));
          }
          try {
            const json = body ? JSON.parse(body) : {};
            resolve((json.data ?? json) as T);
          } catch {
            reject(new ProxmoxApiError('Could not parse Proxmox response as JSON.'));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy(new ProxmoxApiError('Connection to Proxmox timed out.'));
      });
      if (payload) req.write(payload);
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
          reject(new ProxmoxApiError('TLS certificate is self-signed. Disable "Verify TLS certificate" for this server, or install a trusted cert.'));
        } else if (err.code === 'ECONNREFUSED') {
          reject(new ProxmoxApiError('Connection refused — is the base URL and port (usually 8006) correct?'));
        } else if (err.code === 'ENOTFOUND') {
          reject(new ProxmoxApiError('Host not found — check the base URL.'));
        } else {
          reject(new ProxmoxApiError(err.message));
        }
      });
      req.end();
    });
  }

  /** GET /version — used for connection tests. */
  async version(): Promise<{ version: string; release: string }> {
    return this.request('GET', '/version');
  }

  /** All VMs and containers across the cluster. */
  async clusterResources(): Promise<ProxmoxResource[]> {
    return this.request('GET', '/cluster/resources?type=vm');
  }

  /** Change a guest's power state: start | stop | shutdown | reboot | suspend | resume | reset. */
  async setStatus(node: string, type: 'qemu' | 'lxc', vmid: number, action: string): Promise<string> {
    return this.request('POST', `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/${action}`);
  }

  /** The guest's current configuration (cores, memory, disks, nics, ...). */
  async config(node: string, type: 'qemu' | 'lxc', vmid: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/config`);
  }

  /** Live status incl. current mem/cpu usage and (for lxc) more detail. */
  async currentStatus(node: string, type: 'qemu' | 'lxc', vmid: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/current`);
  }

  /** QEMU guest-agent network interfaces (only works if the agent is running). */
  async qemuAgentInterfaces(node: string, vmid: number): Promise<{ result?: Array<{ name: string; 'ip-addresses'?: Array<{ 'ip-address': string; 'ip-address-type': string }> }> }> {
    return this.request('GET', `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/network-get-interfaces`);
  }

  /** LXC network interfaces (from the container). */
  async lxcInterfaces(node: string, vmid: number): Promise<Array<{ name: string; inet?: string; inet6?: string; hwaddr?: string }>> {
    return this.request('GET', `/nodes/${encodeURIComponent(node)}/lxc/${vmid}/interfaces`);
  }

  /** Permanently delete a guest (purge removes it from backup/replication jobs too). */
  async destroy(node: string, type: 'qemu' | 'lxc', vmid: number): Promise<string> {
    return this.request('DELETE', `/nodes/${encodeURIComponent(node)}/${type}/${vmid}?purge=1&destroy-unreferenced-disks=1`);
  }

  // ── Inventory (for wizard dropdowns) ──

  async nodes(): Promise<Array<{ node: string; status: string }>> {
    return this.request('GET', '/nodes');
  }

  /** Storages on a node, optionally filtered by supported content (images | iso | vztmpl). */
  async nodeStorages(node: string, content?: string): Promise<Array<{ storage: string; type: string; content: string; active?: number }>> {
    const q = content ? `?content=${encodeURIComponent(content)}` : '';
    return this.request('GET', `/nodes/${encodeURIComponent(node)}/storage${q}`);
  }

  /** Next free VMID in the cluster. */
  async nextId(): Promise<number> {
    const id = await this.request<string>('GET', '/cluster/nextid');
    return parseInt(String(id), 10);
  }

  /** Storage content of a given type (iso | vztmpl | images | backup). */
  async storageContent(node: string, storage: string, content: string): Promise<Array<{ volid: string; size?: number; format?: string }>> {
    return this.request('GET', `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?content=${encodeURIComponent(content)}`);
  }

  /** Network interfaces on a node (used to list bridges). */
  async networks(node: string): Promise<Array<{ iface: string; type: string; active?: number }>> {
    return this.request('GET', `/nodes/${encodeURIComponent(node)}/network`);
  }

  /** Cluster-level storage definition (includes `path` for file-based storages). */
  async storageConfig(storage: string): Promise<{ storage: string; type: string; path?: string; content?: string }> {
    return this.request('GET', `/storage/${encodeURIComponent(storage)}`);
  }

  // ── Provisioning ──

  /** Clone a VM/template. Returns the task UPID. */
  async cloneVm(node: string, vmid: number, params: Record<string, unknown>): Promise<string> {
    return this.request('POST', `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/clone`, params);
  }

  /** Create a new VM. Returns the task UPID. */
  async createVm(node: string, params: Record<string, unknown>): Promise<string> {
    return this.request('POST', `/nodes/${encodeURIComponent(node)}/qemu`, params);
  }

  /** Create a new LXC container. Returns the task UPID. */
  async createLxc(node: string, params: Record<string, unknown>): Promise<string> {
    return this.request('POST', `/nodes/${encodeURIComponent(node)}/lxc`, params);
  }

  /** Download a file (e.g. a cloud image) from a URL onto a storage. Returns the task UPID. */
  async downloadUrl(node: string, storage: string, params: Record<string, unknown>): Promise<string> {
    return this.request('POST', `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/download-url`, params);
  }

  /** Convert a VM into a template. */
  async convertToTemplate(node: string, vmid: number): Promise<unknown> {
    return this.request('POST', `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/template`);
  }

  /** Update a guest's config (cloud-init fields, cores, memory, ...). */
  async updateConfig(node: string, type: 'qemu' | 'lxc', vmid: number, params: Record<string, unknown>): Promise<unknown> {
    return this.request('PUT', `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/config`, params);
  }

  // ── Snapshots ──

  async listSnapshots(node: string, type: 'qemu' | 'lxc', vmid: number): Promise<Array<{ name: string; description?: string; snaptime?: number; parent?: string; vmstate?: number }>> {
    return this.request('GET', `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/snapshot`);
  }

  async createSnapshot(node: string, type: 'qemu' | 'lxc', vmid: number, params: Record<string, unknown>): Promise<string> {
    return this.request('POST', `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/snapshot`, params);
  }

  async rollbackSnapshot(node: string, type: 'qemu' | 'lxc', vmid: number, snapname: string): Promise<string> {
    return this.request('POST', `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`);
  }

  async deleteSnapshot(node: string, type: 'qemu' | 'lxc', vmid: number, snapname: string): Promise<string> {
    return this.request('DELETE', `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/snapshot/${encodeURIComponent(snapname)}`);
  }

  /** Poll a task's status by UPID. */
  async taskStatus(node: string, upid: string): Promise<{ status: string; exitstatus?: string }> {
    return this.request('GET', `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
  }

  /** Wait for a task (UPID) to finish. Throws if it ends non-OK. */
  async waitForTask(node: string, upid: string, timeoutMs = 300000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const st = await this.taskStatus(node, upid);
      if (st.status === 'stopped') {
        if (st.exitstatus && st.exitstatus !== 'OK') {
          throw new ProxmoxApiError(`Task failed: ${st.exitstatus}`);
        }
        return;
      }
      if (Date.now() > deadline) throw new ProxmoxApiError('Timed out waiting for the Proxmox task to finish.');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
