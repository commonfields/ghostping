import "./globals.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell } from "@/components/app-shell"
import { SettingsProvider } from "@/components/settings-dialog"
import { PreferencesProvider } from "@/lib/preferences"
import { RequireAuth } from "@/lib/session"
import { WorkspaceProvider } from "@/lib/workspace"
import { SignIn, SignUp } from "./routes/auth"
import { Home } from "./routes/home"
import { BusinessLayout, Overview } from "./routes/business"
import { FactsPage } from "./routes/facts"
import { ChecksPage } from "./routes/checks"
import { IssuesPage } from "./routes/issues"
import { ObservationPage } from "./routes/observation"

function App() {
  return (
    <BrowserRouter>
      <PreferencesProvider>
      <TooltipProvider>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          <Route
            element={
              <RequireAuth>
                <WorkspaceProvider>
                  <SettingsProvider>
                    <AppShell />
                  </SettingsProvider>
                </WorkspaceProvider>
              </RequireAuth>
            }
          >
            <Route path="/" element={<Home />} />
            <Route path="/businesses/:id" element={<BusinessLayout />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<Overview />} />
              <Route path="facts" element={<FactsPage />} />
              <Route path="checks" element={<ChecksPage />} />
              <Route path="issues" element={<IssuesPage />} />
            </Route>
            <Route path="/observations/:observationId" element={<ObservationPage />} />
          </Route>
        </Routes>
        <Toaster position="bottom-right" />
      </TooltipProvider>
      </PreferencesProvider>
    </BrowserRouter>
  )
}

const el = document.getElementById("root")
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
