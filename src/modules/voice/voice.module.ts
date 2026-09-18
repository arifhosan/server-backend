import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModelRelayClient } from './clients/modelrelay.client';
import { VoiceboxClient } from './clients/voicebox.client';
import { VoiceGateway } from './gateway/voice.gateway';
import { ConversationService } from './pipeline/conversation.service';
import { VoiceController } from './voice.controller';
import { VoiceConfig } from './voice.config';

@Module({
  imports: [ConfigModule],
  controllers: [VoiceController],
  providers: [
    VoiceConfig,
    VoiceboxClient,
    ModelRelayClient,
    ConversationService,
    VoiceGateway,
  ],
})
export class VoiceModule {}
