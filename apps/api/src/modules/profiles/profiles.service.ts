import { Injectable } from "@nestjs/common";
import type { Profile, UpdateProfileRequest } from "@offerly/types";
import { SupabaseService } from "../supabase/supabase.service.js";

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
    const db = this.supabase.forUser(token);
    const { data, error } = await db
      .from("profiles")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", userId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update profile: ${error.message}`);
    return data as Profile;
  }
}
