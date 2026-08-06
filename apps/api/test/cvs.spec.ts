import { UnprocessableEntityException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { CvsService } from "../src/modules/cvs/cvs.service.js";
import { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import { FakeSupabaseClient, type Terminal } from "./helpers/fake-supabase.js";

const USER = "user-1";
const TOKEN = "token";

function makeService(cvsTerminals: Terminal[]): {
  service: CvsService;
  client: FakeSupabaseClient;
} {
  const client = new FakeSupabaseClient();
  client.queue("cvs", cvsTerminals);
  const supabase = { forUser: () => client } as unknown as SupabaseService;
  return { service: new CvsService(supabase), client };
}

describe("CvsService multi-CV (T12.1)", () => {
  it("createFromText deactivates others BEFORE inserting the new active CV (unique-index safe)", async () => {
    const created = { id: "cv-new", user_id: USER, name: "Pasted CV", is_active: true };
    const { service, client } = makeService([{ data: created }]);

    const cv = await service.createFromText(USER, TOKEN, "x".repeat(60));

    expect(cv.id).toBe("cv-new");
    expect(client.calls[0]).toMatchObject({
      table: "cvs",
      method: "update",
      payload: { is_active: false },
    });
    expect(client.calls[1]).toMatchObject({ table: "cvs", method: "insert" });
    const insert = client.calls[1]?.payload as { name?: string; is_active?: boolean };
    expect(insert.name).toBe("Pasted CV");
    expect(insert.is_active).toBe(true);
  });

  it("createSignedUpload deactivates first and names the row after the original filename", async () => {
    const { service, client } = makeService([{ data: { id: "cv-new" } }]);

    await service.createSignedUpload(USER, TOKEN, {
      filename: "My CV (2026).pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
    });

    expect(client.calls[0]).toMatchObject({
      table: "cvs",
      method: "update",
      payload: { is_active: false },
    });
    const insert = client.calls[1]?.payload as { name?: string; file_path?: string };
    expect(insert.name).toBe("My CV (2026).pdf");
    // Storage path keeps the sanitized name, the display name does not.
    expect(insert.file_path).toContain("My_CV__2026_.pdf");
  });

  it("update with is_active deactivates the others before activating this CV", async () => {
    const cv = { id: "cv-1", user_id: USER, name: "Old", is_active: false };
    const { service, client } = makeService([{ data: cv }]);

    await service.update(USER, TOKEN, "cv-1", { is_active: true });

    expect(client.calls[0]).toMatchObject({
      table: "cvs",
      method: "update",
      payload: { is_active: false },
    });
    expect(client.calls[1]).toMatchObject({
      table: "cvs",
      method: "update",
      payload: { is_active: true },
    });
  });

  it("update trims the name and does not touch activation when only renaming", async () => {
    const cv = { id: "cv-1", user_id: USER, name: "Old", is_active: true };
    const { service, client } = makeService([{ data: cv }]);

    await service.update(USER, TOKEN, "cv-1", { name: "  Product CV  " });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      table: "cvs",
      method: "update",
      payload: { name: "Product CV" },
    });
  });

  it("update rejects empty and over-long names with 422", async () => {
    const cv = { id: "cv-1", user_id: USER, name: "Old", is_active: true };
    const blank = makeService([{ data: cv }]);
    await expect(
      blank.service.update(USER, TOKEN, "cv-1", { name: "   " }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    const long = makeService([{ data: cv }]);
    await expect(
      long.service.update(USER, TOKEN, "cv-1", { name: "x".repeat(121) }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("remove deletes the storage file and the row (dependents cascade via FK)", async () => {
    const cv = { id: "cv-1", user_id: USER, file_path: `${USER}/abc-cv.pdf` };
    const { service, client } = makeService([{ data: cv }]);

    await service.remove(USER, TOKEN, "cv-1");

    expect(client.storageCalls).toEqual([
      { bucket: "cvs", method: "remove", args: [cv.file_path] },
    ]);
    expect(client.calls[0]).toMatchObject({ table: "cvs", method: "delete" });
  });

  it("remove skips storage for pasted CVs", async () => {
    const cv = { id: "cv-1", user_id: USER, file_path: null };
    const { service, client } = makeService([{ data: cv }]);

    await service.remove(USER, TOKEN, "cv-1");

    expect(client.storageCalls).toEqual([]);
    expect(client.calls[0]).toMatchObject({ table: "cvs", method: "delete" });
  });

  it("remove still deletes the row when the storage delete fails (best-effort)", async () => {
    const cv = { id: "cv-1", user_id: USER, file_path: `${USER}/abc-cv.pdf` };
    const { service, client } = makeService([{ data: cv }]);
    client.storageRemoveError = { message: "boom" };

    await expect(service.remove(USER, TOKEN, "cv-1")).resolves.toBeUndefined();
    expect(client.calls[0]).toMatchObject({ table: "cvs", method: "delete" });
  });
});
