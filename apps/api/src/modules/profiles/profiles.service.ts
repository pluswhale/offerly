import { Injectable } from "@nestjs/common";
import type { Profile, UpdateProfileRequest } from "@offerly/types";
import { SupabaseService } from "../supabase/supabase.service.js";
import { mergeUserGoals } from "./merge-user-goals.js";

@Injectable()
export class ProfilesService {
  constructor(private readonly supabase: SupabaseService) {}

  /** First GET auto-creates the row if the auth trigger hasn't (T3.x fallback). */
  async getMe(userId: string, token: string): Promise<Profile> {
    const db = this.supabase.forUser(token);
    const { data } = await db
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (data) return data as Profile;

    const { data: created, error } = await db
      .from("profiles")
      .insert({ id: userId })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to create profile: ${error.message}`);
    return created as Profile;
  }

  async updateMe(
    userId: string,
    token: string,
    patch: UpdateProfileRequest,
  ): Promise<Profile> {
    // user_goals is a partial merge (spec 003 §FR-11): read the stored goals
    // and merge so unset keys aren't clobbered.
    let userGoals: Profile["user_goals"] | undefined;
    if (patch.user_goals !== undefined) {
      const current = await this.getMe(userId, token);
      userGoals = mergeUserGoals(current.user_goals, patch.user_goals);
    }

    const { user_goals: _ignored, ...scalarPatch } = patch;
    const db = this.supabase.forUser(token);
    const { data, error } = await db
      .from("profiles")
      .update({
        ...scalarPatch,
        ...(userGoals !== undefined ? { user_goals: userGoals } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update profile: ${error.message}`);
    return data as Profile;
  }
}
