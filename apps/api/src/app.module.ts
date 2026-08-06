import { Module } from "@nestjs/common";
import { AppController } from "./app.controller.js";
import { AiModule } from "./modules/ai/ai.module.js";
import { ApplicationsModule } from "./modules/applications/applications.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { BillingModule } from "./modules/billing/billing.module.js";
import { CandidateProfilesModule } from "./modules/candidate-profiles/candidate-profiles.module.js";
import { CoachModule } from "./modules/coach/coach.module.js";
import { CvImprovementsModule } from "./modules/cv-improvements/cv-improvements.module.js";
import { CvReviewModule } from "./modules/cv-review/cv-review.module.js";
import { CvsModule } from "./modules/cvs/cvs.module.js";
import { EntitlementsModule } from "./modules/entitlements/entitlements.module.js";
import { JobsModule } from "./modules/jobs/jobs.module.js";
import { ProfilesModule } from "./modules/profiles/profiles.module.js";
import { SupabaseModule } from "./modules/supabase/supabase.module.js";
import { UsageModule } from "./modules/usage/usage.module.js";

@Module({
  imports: [
    SupabaseModule,
    AuthModule,
    EntitlementsModule,
    AiModule,
    ProfilesModule,
    CvsModule,
    CandidateProfilesModule,
    CvReviewModule,
    CvImprovementsModule,
    JobsModule,
    ApplicationsModule,
    CoachModule,
    BillingModule,
    UsageModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
