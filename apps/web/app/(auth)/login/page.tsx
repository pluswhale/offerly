import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Log in — Offerly" };

export default function LoginPage() {
  return (
    <Suspense>
      <AuthForm mode="login" />
    </Suspense>
  );
}
