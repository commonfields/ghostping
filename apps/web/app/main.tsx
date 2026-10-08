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
import { AssayPage } from "./routes/assay"
import { ChecksPage } from "./routes/checks"
import { DiscoveryPage } from "./routes/discovery"
import { IssueDetailPage } from "./routes/issue"
import { IssuesPage } from "./routes/issues"
import { ObservationPage } from "./routes/observation"
import { RepresentationDetailPage } from "./routes/representation"
import { RepresentationsPage } from "./routes/representations"
import { SearchOverviewPage } from "./routes/search"
import { SiteFindingPage } from "./routes/site-finding"
import { SiteRunPage } from "./routes/site-run"
import { TruthPage } from "./routes/truth"
import { ClientsPage } from "./routes/clients"
import { ClientRecordPage } from "./routes/client"
import { PublicRecordPage } from "./routes/public-record"

function App() {
  return (
    <BrowserRouter>
      <PreferencesProvider>
      <TooltipProvider>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          {/* The client-facing record: public, read-only, outside the workspace shell. */}
          <Route path="/open/:publicId" element={<PublicRecordPage />} />
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
            <Route path="/" element={<Navigate to="/clients" replace />} />
            <Route path="/clients" element={<ClientsPage />} />
            <Route path="/clients/:id" element={<ClientRecordPage />} />
            <Route path="/businesses" element={<Home />} />
            <Route path="/businesses/:id" element={<BusinessLayout />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<Overview />} />
              <Route path="truth" element={<TruthPage />} />
              <Route path="facts" element={<Navigate to="../truth" replace />} />
              <Route path="assay" element={<AssayPage />} />
              <Route path="checks" element={<ChecksPage />} />
              <Route path="search" element={<SearchOverviewPage />} />
              <Route path="search/sites/:siteId/runs/:runId" element={<SiteRunPage />} />
              <Route path="search/sites/:siteId/findings/:findingId" element={<SiteFindingPage />} />
              <Route path="issues" element={<IssuesPage />} />
              <Route path="issues/:claimId" element={<IssueDetailPage />} />
              <Route path="representations" element={<RepresentationsPage />} />
              <Route path="representations/discovery" element={<DiscoveryPage />} />
              <Route path="representations/:bindingId" element={<RepresentationDetailPage />} />
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
