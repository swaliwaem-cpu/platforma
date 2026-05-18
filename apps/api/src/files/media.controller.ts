import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';

import { MediaTokenGuard } from '../auth/media-token.guard';
import { type FileContentResponse, sendFileContentResponse } from './file-content-response';
import { FilesService } from './files.service';

@Controller('media/files')
@UseGuards(MediaTokenGuard)
export class MediaController {
  constructor(private readonly filesService: FilesService) {}

  @Get(':id/content')
  async getContent(
    @Param('id') id: string,
    @Query('variant') variant: string | undefined,
    @Res() response: FileContentResponse,
  ) {
    const content = await this.filesService.getContent(id, variant);

    sendFileContentResponse(response, content);
  }
}
