import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router"
import { RequireAuth } from "./lib/session.js"
import { SignIn, SignUp } from "./routes/auth.js"
import { Home } from "./routes/home.js"
import { BusinessLayout, Overview } from "./routes/business.js"
import { FactsPage } from "./routes/facts.js"
import { ChecksPage } from "./routes/checks.js"
import { IssuesPage } from "./routes/issues.js"
import { ObservationPage } from "./routes/observation.js"

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route path="/signup" element={<SignUp />} />
        <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
        <Route path="/businesses/:id" element={<RequireAuth><BusinessLayout /></RequireAuth>}>
          <Route path="overview" element={<Overview />} />
          <Route path="facts" element={<FactsPage />} />
          <Route path="checks" element={<ChecksPage />} />
          <Route path="issues" element={<IssuesPage />} />
        </Route>
        <Route path="/observations/:observationId" element={<RequireAuth><ObservationPage /></RequireAuth>} />
      </Routes>
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
