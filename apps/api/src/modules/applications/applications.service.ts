import { Injectable, NotFoundException } from "@nestjs/common";
import {
  type Application,
  type CreateApplicationRequest,
  type UpdateApplicationRequest,
} from "@offerly/types";
import { SupabaseService } from "../supabase/supabase.service.js";

@Injectable()
export class ApplicationsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(
    userId: string,
    token: string,
    filter: { status?: string; archived?: boolean },
  ): Promise<Application[]> {
    const db = this.supabase.forUser(token);
    let query = db
      .from("applications")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (filter.status) query = query.eq("status", filter.status);
    if (filter.archived !== undefined) query = query.eq("archived", filter.archived);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to list applications: ${error.message}`);
    return (data ?? []) as Application[];
  }

  async create(
    userId: string,
    token: string,
    input: CreateApplicationRequest,
  ): Promise<Application> {
    const db = this.supabase.forUser(token);
    const { data, error } = await db
      .from("applications")
      .insert({
        user_id: userId,
        job_id: input.job_id ?? null,
        company: input.company,
        role: input.role,
        status: input.status ?? "saved",
        applied_at: input.applied_at ?? null,
        notes: input.notes ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to create application: ${error.message}`);
    return data as Application;
  }

  async update(
    userId: string,
    token: string,
    id: string,
    patch: UpdateApplicationRequest,
  ): Promise<Application> {
    const db = this.supabase.forUser(token);
    const { data, error } = await db
      .from("applications")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(`Failed to update application: ${error.message}`);
    if (!data) throw new NotFoundException("Application not found");
    return data as Application;
  }

  async remove(userId: string, token: string, id: string): Promise<{ deleted: true }> {
    const db = this.supabase.forUser(token);
    const { data, error } = await db
      .from("applications")
      .delete()
      .eq("id", id)
      .eq("user_id", userId)
      .select("id");
    if (error) throw new Error(`Failed to delete application: ${error.message}`);
    if (!data || data.length === 0) throw new NotFoundException("Application not found");
    return { deleted: true };
  }
}
