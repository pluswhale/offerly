import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sign up — Offerly" };

export default function SignupPage() {
  return (
    <Suspense>
      <AuthForm mode="signup" />
    </Suspense>
  );
}
