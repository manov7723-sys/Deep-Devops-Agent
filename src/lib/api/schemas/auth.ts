import { z } from "zod";

// Password policy mirrors `src/components/auth/PasswordChecklist.tsx` exactly.
// Server is the authority — client checklist is UX, this is the gate.
export const PasswordPolicy = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/\d/, "Password must contain a number")
  .regex(/[^A-Za-z0-9]/, "Password must contain a symbol");

export const SignupRequest = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(80),
  lastName: z.string().trim().min(1, "Last name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: PasswordPolicy,
  terms: z.literal(true, {
    errorMap: () => ({ message: "You must accept the Terms and Privacy Policy" }),
  }),
});
export type SignupRequest = z.infer<typeof SignupRequest>;

export const LoginRequest = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
  remember: z.boolean().optional().default(true),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

// Shared success shape for signup + login. `needsTotp` is always true in Phase 1
// (TOTP is mandatory at signup; login always lands in pending_mfa).
export const AuthSuccess = z.object({
  ok: z.literal(true),
  needsTotp: z.literal(true),
  setup: z.boolean(), // true = signup → must set up TOTP; false = login → enter code
});
export type AuthSuccess = z.infer<typeof AuthSuccess>;

export const AuthError = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  fieldErrors: z.record(z.string()).optional(),
});
export type AuthError = z.infer<typeof AuthError>;

export const ForgotRequest = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});
export type ForgotRequest = z.infer<typeof ForgotRequest>;

export const ResetRequest = z
  .object({
    token: z.string().min(1, "Reset token is required"),
    password: PasswordPolicy,
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });
export type ResetRequest = z.infer<typeof ResetRequest>;
