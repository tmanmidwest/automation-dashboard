import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LoggingModule } from '../logging/logging.module';
import { KevService } from './kev.service';
import { OsvService } from './osv.service';
import { CveInfoService } from './cve-info.service';

/** Shared vulnerability data from public feeds: CISA KEV, OSV.dev, CVE scores + EPSS. */
@Module({
  imports: [PrismaModule, LoggingModule],
  providers: [KevService, OsvService, CveInfoService],
  exports: [KevService, OsvService, CveInfoService],
})
export class VulnIntelModule {}
