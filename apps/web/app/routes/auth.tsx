import { useState, type ReactNode } from "react"
import { Link, useNavigate } from "react-router"
import { CircleAlertIcon } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/spinner"
import { Auth } from "@/lib/api"
import { rememberEmail } from "@/lib/preferences"
import { errorMessage } from "@/lib/format"

function AuthLayout({ title, description, children, footer }: { title: string; description: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-sidebar px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border bg-card p-6 shadow-xs sm:p-8">
          <div className="mb-6 space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          {children}
        </div>
        <p className="mt-6 text-center text-sm text-muted-foreground">{footer}</p>
      </div>
    </div>
  )
}

function authError(err: unknown, mode: "signin" | "signup"): string {
  const e = err as { status?: number; tag?: string }
  if (mode === "signin" && (e.status === 401 || e.status === 403)) return "That email and password do not match an account."
  if (mode === "signup" && e.status === 409) return "An account with that email already exists. Sign in instead."
  if (mode === "signup" && e.status === 422) return "Use a valid email and a password of at least 8 characters."
  return errorMessage(err)
}

function CredentialsForm({ mode }: { mode: "signin" | "signup" }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const nav = useNavigate()

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        setPending(true)
        const call = mode === "signin" ? Auth.signin(email, password) : Auth.signup(email, password)
        call
          .then(() => {
            rememberEmail(email)
            nav("/")
          })
          .catch((err: unknown) => setError(authError(err, mode)))
          .finally(() => setPending(false))
      }}
    >
      {error ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle className="font-normal">{error}</AlertTitle>
        </Alert>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} placeholder="you@company.com" />
      </div>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          {mode === "signup" ? <span className="text-xs text-muted-foreground">At least 8 characters</span> : null}
        </div>
        <Input
          id="password"
          type="password"
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          required
          minLength={mode === "signup" ? 8 : undefined}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? <Spinner /> : null}
        {mode === "signin" ? "Sign in" : "Create account"}
      </Button>
      {/* Seeded demo login: local development only, never in a production build. */}
      {mode === "signin" && import.meta.env.DEV ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-mt-2 text-muted-foreground"
          onClick={() => {
            setEmail("demo@northstar.test")
            setPassword("password123")
          }}
        >
          Fill in the demo account
        </Button>
      ) : null}
    </form>
  )
}

export function SignIn() {
  return (
    <AuthLayout
      title="Sign in"
      description="See what AI assistants are saying about your business, with the evidence."
      footer={
        <>
          No account yet?{" "}
          <Link to="/signup" className="font-medium text-foreground underline-offset-4 hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <CredentialsForm mode="signin" />
    </AuthLayout>
  )
}

export function SignUp() {
  return (
    <AuthLayout
      title="Create your account"
      description="Add your business, write down the facts you stand behind, and start checking AI answers."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/signin" className="font-medium text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <CredentialsForm mode="signup" />
    </AuthLayout>
  )
}
