import { NavLink, Route, Routes } from "react-router-dom";
import "./App.css";
import HQPage from "./pages/HQPage.js";
import JobsFloorPage from "./pages/JobsFloorPage.js";
import JobDetailPage from "./pages/JobDetailPage.js";
import ApprovalsPage from "./pages/ApprovalsPage.js";
import IntegrationsPage from "./pages/IntegrationsPage.js";
import QuotesPage from "./pages/QuotesPage.js";
import QuoteBuilderPage from "./pages/QuoteBuilderPage.js";
import LeadsPage from "./pages/LeadsPage.js";
import LeadDetailPage from "./pages/LeadDetailPage.js";
import BusinessProfilePage from "./pages/BusinessProfilePage.js";
import FinancePage from "./pages/FinancePage.js";
import DebtorsPage from "./pages/DebtorsPage.js";
import DirectorWidget from "./components/DirectorWidget.js";

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">GE</span>
          <div>
            <div className="brand-name">Goodall Electrical</div>
            <div className="brand-sub">AI Business Operating System</div>
          </div>
        </div>
        <nav className="app-nav">
          <NavLink to="/" end>
            HQ
          </NavLink>
          <NavLink to="/jobs">Jobs Floor</NavLink>
          <NavLink to="/quotes">Quotes</NavLink>
          <NavLink to="/finance">Finance</NavLink>
          <NavLink to="/debtors">Debtors</NavLink>
          <NavLink to="/leads">Lead Radar</NavLink>
          <NavLink to="/approvals">Approvals</NavLink>
          <NavLink to="/business-profile">Business Profile</NavLink>
          <NavLink to="/integrations">Integrations</NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<HQPage />} />
          <Route path="/jobs" element={<JobsFloorPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/quotes" element={<QuotesPage />} />
          <Route path="/quotes/new" element={<QuoteBuilderPage />} />
          <Route path="/finance" element={<FinancePage />} />
          <Route path="/debtors" element={<DebtorsPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/business-profile" element={<BusinessProfilePage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
        </Routes>
      </main>
      <DirectorWidget />
    </div>
  );
}
