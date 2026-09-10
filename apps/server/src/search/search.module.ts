import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';

/** Cross-connector resource search index for the command palette. See docs/command-palette.md. */
@Module({
  imports: [ConnectorsModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
