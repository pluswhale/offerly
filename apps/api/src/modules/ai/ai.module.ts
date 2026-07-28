import { Module } from "@nestjs/common";
import { env } from "../../common/env.js";
import { AiService } from "./ai.service.js";
import { LLM_PROVIDER, type LlmProvider } from "./llm-provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.provider.js";

@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      useFactory: (): LlmProvider =>
        new OpenAiCompatibleProvider({
          apiKey: env("LLM_PROVIDER_API_KEY", ""),
          baseUrl: env("LLM_BASE_URL", "https://api.openai.com/v1"),
        }),
    },
    AiService,
  ],
  exports: [AiService],
})
export class AiModule {}
