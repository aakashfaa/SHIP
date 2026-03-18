const STORAGE_KEY = "ship-workspace-prototype-v1";

const USERS = [
  { email: "admin@gmail.com", password: "1234", role: "admin", name: "Admin" },
  { email: "consultant1@gmail.com", password: "1234", role: "consultant", name: "Consultant 1" },
  { email: "consultant2@gmail.com", password: "1234", role: "consultant", name: "Consultant 2" },
];

const DISCIPLINES = [
  { key: "architectural", label: "Architectural", shortLabel: "Arch", code: "A", color: "#f59a3b" },
  { key: "accessibility", label: "Accessibility", shortLabel: "Accessibility", code: "AD", color: "#1f7a24" },
  { key: "civil", label: "Civil", shortLabel: "Civil", code: "C", color: "#eb33bc" },
  { key: "electrical", label: "Electrical", shortLabel: "Electrical", code: "E", color: "#95c94f" },
  { key: "envelope", label: "Envelope", shortLabel: "Envelope", code: "EN", color: "#236f94" },
  { key: "fireAlarm", label: "Fire Alarm", shortLabel: "Fire Alarm", code: "F", color: "#d7d7d7" },
  { key: "hazardousMaterials", label: "Hazardous Materials", shortLabel: "HazMat", code: "HM", color: "#a77138" },
  { key: "historicPreservation", label: "Historic Preservation", shortLabel: "Historic", code: "HP", color: "#ead8cc" },
  { key: "landscape", label: "Landscape", shortLabel: "Landscape", code: "L", color: "#c7ddb7" },
  { key: "mechanical", label: "Mechanical", shortLabel: "Mechanical", code: "M", color: "#f4be16" },
  { key: "plumbing", label: "Plumbing", shortLabel: "Plumbing", code: "P", color: "#d7b7d8" },
  { key: "structural", label: "Structural", shortLabel: "Structural", code: "S", color: "#4ac7d5" },
  { key: "security", label: "Security", shortLabel: "Security", code: "SC", color: "#a6a6a6" },
  { key: "telecom", label: "Telecom", shortLabel: "Telecom", code: "T", color: "#aad494" },
];

const CATEGORY_OPTIONS = [
  "END OF LIFE",
  "DEFERRED MAINTENANCE",
  "UPGRADES / IMPROVEMENTS",
  "RESTORATION *",
  "STUDY / DOCUMENTATION",
];

const TIMELINE_OPTIONS = [
  "0_PRIORITY *",
  "1_HIGH <5 years",
  "2_MID 5-10 years",
  "3_LOW 10-20 years",
  "4_FUTURE >20 years",
  "5_250th ANNIVERSARY",
];

const BUILDING_AREA_OPTIONS = [
  "WHOLE BUILDING",
  "ANNEX",
  "WEST WING",
  "EAST WING",
  "BULFINCH",
  "SITE",
  "OTHER *",
];

const BUILDING_LEVEL_OPTIONS = [
  "WHOLE BUILDING",
  "ROOF",
  "ENVELOPE (EXT. WALLS)",
  "LEVELS ABOVE GRADE",
  "LEVELS BELOW GRADE",
  "L5",
  "L4",
  "L3",
  "L2",
  "L1",
  "BASEMENT",
  "SUB BASEMENT",
  "OTHER *",
];

const IMPACT_OPTIONS = ["NONE", "LOW", "MODERATE", "HIGH"];
const BENEFIT_OPTIONS = ["NONE", "LOW", "MODERATE", "HIGH"];
const COST_OPTIONS = ["$ LOW", "$$ MODERATE", "$$$ HIGH"];
const OPERATION_COST_OPTIONS = ["MINIMAL IMPACT", "MODERATE REDUCTION", "HIGH REDUCTION", "INCREASE", "N/A"];
const ENERGY_OPTIONS = ["MINIMAL IMPACT", "MODERATE REDUCTION", "HIGH REDUCTION", "N/A"];
const ELECTRIFICATION_OPTIONS = ["NONE", "LOW", "MODERATE", "HIGH"];
const BOOLEAN_FIELDS = [
  { name: "resiliency", label: "Addressing Resiliency / Sustainability" },
  { name: "deferredMaintenance", label: "Addressing Deferred Maintenance" },
  { name: "codeLifeSafety", label: "Code / Life Safety Improvement" },
  { name: "accessibilityImprovement", label: "Accessibility Improvement" },
  { name: "historicImpact", label: "Historic Impact" },
];

const PRIORITY_RANK = TIMELINE_OPTIONS.reduce((map, value, index) => {
  map[value] = index;
  return map;
}, {});

const COST_RANK = COST_OPTIONS.reduce((map, value, index) => {
  map[value] = index;
  return map;
}, {});

const DISCIPLINE_MAP = Object.fromEntries(DISCIPLINES.map((discipline) => [discipline.key, discipline]));

let state = loadState();

const app = document.getElementById("app");
app.addEventListener("click", handleClick);
app.addEventListener("submit", handleSubmit);
app.addEventListener("input", handleInput);
app.addEventListener("change", handleChange);

render();

function loadState() {
  const baseState = {
    sessionEmail: "",
    projects: [],
    ui: {
      activeProjectId: "",
      activeTab: "data",
      editingLineItemId: "",
      loginError: "",
      projectDraft: createProjectDraft(),
      lineItemDraft: createLineItemDraft("architectural"),
      combinedFilters: {
        search: "",
        category: "all",
        timeline: "all",
        sort: "priority",
        disciplines: [],
      },
      byProject: {
        newName: "",
        search: "",
        targetSubprojectId: "",
      },
    },
  };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return baseState;
    const parsed = JSON.parse(raw);
    return {
      ...baseState,
      ...parsed,
      ui: {
        ...baseState.ui,
        ...(parsed.ui || {}),
        projectDraft: {
          ...baseState.ui.projectDraft,
          ...((parsed.ui || {}).projectDraft || {}),
          contacts: {
            ...baseState.ui.projectDraft.contacts,
            ...((((parsed.ui || {}).projectDraft || {}).contacts) || {}),
          },
        },
        lineItemDraft: {
          ...baseState.ui.lineItemDraft,
          ...((parsed.ui || {}).lineItemDraft || {}),
        },
        combinedFilters: {
          ...baseState.ui.combinedFilters,
          ...((parsed.ui || {}).combinedFilters || {}),
        },
        byProject: {
          ...baseState.ui.byProject,
          ...((parsed.ui || {}).byProject || {}),
        },
      },
      projects: (parsed.projects || []).map(normalizeProject),
    };
  } catch (error) {
    console.error("Unable to load state", error);
    return baseState;
  }
}

function normalizeProject(project) {
  return {
    ...project,
    disciplines: (project.disciplines || []).map((discipline) => ({
      ...discipline,
      ...DISCIPLINE_MAP[discipline.key],
    })),
    items: (project.items || []).map((item) => ({
      ...createLineItemDraft(item.disciplineKey),
      ...item,
      potentialSynergies: item.potentialSynergies || [],
    })),
    subprojects: (project.subprojects || []).map((subproject) => ({
      ...subproject,
      items: (subproject.items || []).map((entry) => ({ ...entry })),
    })),
  };
}

function saveState() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function createProjectDraft() {
  const contacts = {};
  DISCIPLINES.filter((discipline) => discipline.key !== "architectural").forEach((discipline) => {
    contacts[discipline.key] = { orgName: "", email: "" };
  });

  return {
    name: "",
    selectedDisciplines: [],
    contacts,
  };
}

function createLineItemDraft(disciplineKey) {
  return {
    id: "",
    disciplineKey,
    lineNumber: "",
    name: "",
    category: CATEGORY_OPTIONS[0],
    timelinePriority: TIMELINE_OPTIONS[0],
    buildingArea: BUILDING_AREA_OPTIONS[0],
    buildingLevel: BUILDING_LEVEL_OPTIONS[0],
    operationalImpact: IMPACT_OPTIONS[0],
    userBenefit: BENEFIT_OPTIONS[1],
    publicBenefit: BENEFIT_OPTIONS[1],
    firstCost: COST_OPTIONS[0],
    operationCostImpact: OPERATION_COST_OPTIONS[0],
    energyImpact: ENERGY_OPTIONS[0],
    electrification: ELECTRIFICATION_OPTIONS[0],
    resiliency: false,
    deferredMaintenance: false,
    codeLifeSafety: false,
    accessibilityImprovement: false,
    historicImpact: false,
    potentialSynergies: [],
    notes: "",
  };
}

function currentUser() {
  return USERS.find((user) => user.email === state.sessionEmail) || null;
}

function accessibleProjects(user) {
  if (!user) return [];
  if (user.role === "admin") return state.projects;
  return state.projects.filter((project) =>
    project.disciplines.some((discipline) => discipline.email.toLowerCase() === user.email.toLowerCase())
  );
}

function activeProject(user) {
  const projects = accessibleProjects(user);
  const project = projects.find((entry) => entry.id === state.ui.activeProjectId);
  if (project) return project;
  return null;
}

function allowedDisciplinesForProject(project, user) {
  if (!project || !user) return [];
  if (user.role === "admin") {
    return project.disciplines.filter((discipline) => discipline.key === "architectural");
  }
  return project.disciplines.filter((discipline) => discipline.email.toLowerCase() === user.email.toLowerCase());
}

function render() {
  const user = currentUser();
  if (!user) {
    app.innerHTML = renderAuthScreen();
    return;
  }

  const project = activeProject(user);
  app.innerHTML = `
    <div class="app-shell">
      ${renderTopbar(user, project)}
      ${project ? renderWorkspace(user, project) : renderDashboard(user)}
    </div>
  `;
}

function renderAuthScreen() {
  return `
    <div class="auth-shell">
      <section class="auth-hero">
        <div class="hero-panel glass-card">
          <div class="eyebrow"><strong>Finegold Alexander</strong> SHIP prototype workspace</div>
          <h1 class="hero-title">Project data entry should feel designed, not endured.</h1>
          <p class="hero-copy">
            This prototype sets up a fake authentication layer, an admin project intake flow, and a shared workspace for
            consultants to enter and structure project options with clearer visual hierarchy.
          </p>
          <div class="hero-grid">
            <div class="mini-metric">
              <strong>4</strong>
              Workspace tabs: add data, combined view, byProject, and a reserved visual layer.
            </div>
            <div class="mini-metric">
              <strong>14</strong>
              Discipline colors follow the trade palette from your matrix reference image.
            </div>
            <div class="mini-metric">
              <strong>PP10</strong>
              Sub-project codes auto-sequence from the first project package.
            </div>
            <div class="mini-metric">
              <strong>Local</strong>
              Everything runs in-browser with persistent demo state for review.
            </div>
          </div>
        </div>
        <div class="auth-panel glass-card">
          <div>
            <h2>Prototype login</h2>
            <p class="panel-subtitle">Use one of the seeded accounts below. All passwords are <span class="mono">1234</span>.</p>
          </div>
          <form id="login-form" class="login-form">
            <div class="field">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" autocomplete="username" placeholder="admin@gmail.com">
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" autocomplete="current-password" placeholder="1234">
            </div>
            ${state.ui.loginError ? `<div class="helper-strip">${escapeHtml(state.ui.loginError)}</div>` : ""}
            <div class="button-row">
              <button class="button" type="submit">Enter workspace</button>
            </div>
          </form>
          <div class="account-list">
            ${USERS.map(
              (user) => `
                <button class="account-card" type="button" data-fill-login="${user.email}">
                  <span>
                    <strong>${escapeHtml(user.email)}</strong>
                    ${user.role === "admin" ? "Admin view" : "Consultant view"}
                  </span>
                  <span>Use account</span>
                </button>
              `
            ).join("")}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderTopbar(user, project) {
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">FA</div>
        <div class="brand-copy">
          <h1>SHIP Workspace</h1>
          <p class="panel-subtitle">Project intake, consultant contribution, and option packaging in one place.</p>
        </div>
      </div>
      <div class="user-meta">
        ${project ? `<span class="pill">${escapeHtml(project.name)}</span>` : ""}
        <span class="tag">${user.role === "admin" ? "Admin session" : "Consultant session"}</span>
        <span class="pill">${escapeHtml(user.email)}</span>
        <button class="ghost-button" type="button" data-action="logout">Log out</button>
      </div>
    </header>
  `;
}

function renderDashboard(user) {
  return user.role === "admin" ? renderAdminDashboard(user) : renderConsultantDashboard(user);
}

function renderAdminDashboard(user) {
  const projects = accessibleProjects(user);
  const draft = state.ui.projectDraft;
  const selectedSet = new Set(draft.selectedDisciplines);

  return `
    <section class="dashboard-grid">
      <div class="panel">
        <div class="section-header">
          <div>
            <h2 class="panel-title">Admin home</h2>
            <p class="panel-subtitle">Set up a new project, selectively add consultant trades, then send the team into the shared workspace.</p>
          </div>
          <button class="soft-button" type="button" data-action="load-demo">Load demo project</button>
        </div>
        <form id="project-create-form" class="stack-form">
          <div class="field-full">
            <label for="project-name">Project name</label>
            <input id="project-name" name="projectName" value="${escapeAttribute(draft.name)}" placeholder="State House Campus Renewal">
          </div>
          <div class="helper-strip">
            Architectural is locked to Finegold Alexander for this prototype. For consultant testing, use
            <span class="mono">consultant1@gmail.com</span> and <span class="mono">consultant2@gmail.com</span>.
          </div>
          <div>
            <div class="section-header">
              <div>
                <h3 class="panel-title">Consultant matrix</h3>
                <p class="panel-subtitle">Only add the disciplines this project actually needs. Tapping a chip opens the org and email fields.</p>
              </div>
            </div>
            <div class="discipline-picker">
              ${DISCIPLINES.filter((discipline) => discipline.key !== "architectural").map(
                (discipline) => `
                  <button
                    class="discipline-toggle ${selectedSet.has(discipline.key) ? "active" : ""}"
                    type="button"
                    data-toggle-discipline="${discipline.key}"
                  >
                    ${escapeHtml(discipline.label)}
                  </button>
                `
              ).join("")}
            </div>
          </div>
          <div class="discipline-stack">
            ${renderArchitecturalLeadCard()}
            ${draft.selectedDisciplines.map((disciplineKey) => renderDisciplineContactCard(disciplineKey, draft.contacts[disciplineKey])).join("")}
          </div>
          <div class="button-row">
            <button class="button" type="submit">Create project and open workspace</button>
          </div>
        </form>
      </div>
      <div class="panel">
        <div class="section-header">
          <div>
            <h2 class="panel-title">Projects</h2>
            <p class="panel-subtitle">Open an existing workspace or seed a demo project to inspect the consultant flow immediately.</p>
          </div>
        </div>
        ${
          projects.length
            ? `
              <div class="project-list">
                ${projects.map((project) => renderProjectCard(project, user)).join("")}
              </div>
            `
            : renderEmptyState(
                "No projects yet",
                "Create a project on the left or load the demo dataset to review the interface with sample line items and packaged sub-projects."
              )
        }
      </div>
    </section>
  `;
}

function renderConsultantDashboard(user) {
  const projects = accessibleProjects(user);

  return `
    <section class="dashboard-grid">
      <div class="panel">
        <div class="section-header">
          <div>
            <h2 class="panel-title">Consultant home</h2>
            <p class="panel-subtitle">Projects appear here when the admin assigns your email to one or more disciplines.</p>
          </div>
        </div>
        <div class="role-note">
          You can enter line items only for the disciplines assigned to <span class="mono">${escapeHtml(user.email)}</span>, but you can review the shared project package and combined data views.
        </div>
        <div class="stats-row">
          <div class="stat-card">
            <strong>${projects.length}</strong>
            Active projects
          </div>
          <div class="stat-card">
            <strong>${projects.reduce((total, project) => total + project.disciplines.filter((discipline) => discipline.email.toLowerCase() === user.email.toLowerCase()).length, 0)}</strong>
            Assigned disciplines
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="section-header">
          <div>
            <h2 class="panel-title">Assigned workspaces</h2>
            <p class="panel-subtitle">Open a project to add discipline-specific data or review the current breakdown.</p>
          </div>
        </div>
        ${
          projects.length
            ? `<div class="project-list">${projects.map((project) => renderProjectCard(project, user)).join("")}</div>`
            : renderEmptyState(
                "Nothing assigned yet",
                "Use the admin login to create a project and assign consultant1@gmail.com or consultant2@gmail.com to a discipline."
              )
        }
      </div>
    </section>
  `;
}

function renderProjectCard(project, user) {
  const userDisciplines =
    user.role === "admin"
      ? ["Architectural lead"]
      : project.disciplines
          .filter((discipline) => discipline.email.toLowerCase() === user.email.toLowerCase())
          .map((discipline) => discipline.label);

  return `
    <article class="project-card" style="--brand:${DISCIPLINE_MAP.architectural.color}">
      <h3>${escapeHtml(project.name)}</h3>
      <div class="meta-row">
        <span class="pill">${project.items.length} line items</span>
        <span class="pill">${project.subprojects.length} sub-projects</span>
        <span class="pill">${project.disciplines.length} disciplines</span>
      </div>
      <div class="meta-row">
        ${userDisciplines.map((label) => `<span class="tag">${escapeHtml(label)}</span>`).join("")}
      </div>
      <div class="button-row" style="margin-top:16px;">
        <button class="button" type="button" data-open-project="${project.id}">Open workspace</button>
      </div>
    </article>
  `;
}

function renderArchitecturalLeadCard() {
  return `
    <article class="discipline-card" style="--brand:${DISCIPLINE_MAP.architectural.color}">
      <div class="discipline-head">
        <div>
          <h3>Architectural</h3>
          <p class="panel-subtitle">Default admin discipline</p>
        </div>
        <span class="tag">Required</span>
      </div>
      <div class="field-grid">
        <div class="field">
          <label>Organization</label>
          <input value="Finegold Alexander" disabled>
        </div>
        <div class="field">
          <label>Email</label>
          <input value="admin@gmail.com" disabled>
        </div>
      </div>
    </article>
  `;
}

function renderDisciplineContactCard(disciplineKey, contact) {
  const discipline = DISCIPLINE_MAP[disciplineKey];
  return `
    <article class="discipline-card" style="--brand:${discipline.color}">
      <div class="discipline-head">
        <div>
          <h3>${escapeHtml(discipline.label)}</h3>
          <p class="panel-subtitle">Invite details for this trade</p>
        </div>
        <span class="legend-chip"><span class="legend-swatch" style="background:${discipline.color}"></span>${escapeHtml(discipline.shortLabel)}</span>
      </div>
      <div class="field-grid">
        <div class="field">
          <label for="org-${discipline.key}">Organization</label>
          <input id="org-${discipline.key}" name="org-${discipline.key}" data-contact-org="${discipline.key}" value="${escapeAttribute(contact.orgName)}" placeholder="Consultant organization">
        </div>
        <div class="field">
          <label for="email-${discipline.key}">Email</label>
          <input id="email-${discipline.key}" name="email-${discipline.key}" data-contact-email="${discipline.key}" value="${escapeAttribute(contact.email)}" placeholder="consultant1@gmail.com">
        </div>
      </div>
    </article>
  `;
}

function renderWorkspace(user, project) {
  const assignedDisciplines = allowedDisciplinesForProject(project, user);
  ensureLineItemDraft(project, assignedDisciplines);
  const draft = state.ui.lineItemDraft;

  return `
    <section class="workspace-panel">
      <div class="workspace-header">
        <div>
          <button class="ghost-button" type="button" data-action="back-dashboard">Back to dashboard</button>
          <h2 style="margin-top:16px;">${escapeHtml(project.name)}</h2>
          <p class="panel-subtitle">
            Shared workspace for consultant inputs, combined matrix review, and packaged sub-project definition.
          </p>
          <div class="meta-row">
            ${project.disciplines.map(
              (discipline) => `
                <span class="legend-chip">
                  <span class="legend-swatch" style="background:${discipline.color}"></span>
                  ${escapeHtml(discipline.label)}
                </span>
              `
            ).join("")}
          </div>
        </div>
        <div>
          <div class="helper-strip">
            ${
              user.role === "admin"
                ? "Admin data entry is pinned to Architectural in this prototype."
                : `Assigned discipline${assignedDisciplines.length === 1 ? "" : "s"}: ${assignedDisciplines.map((discipline) => discipline.label).join(", ")}`
            }
          </div>
        </div>
      </div>
      <div class="tab-row">
        ${[
          { key: "data", label: "Add Data" },
          { key: "combined", label: "Combined Data" },
          { key: "byProject", label: "byProject" },
          { key: "visual", label: "Visual" },
        ]
          .map(
            (tab) => `
              <button class="tab-button ${state.ui.activeTab === tab.key ? "active" : ""}" type="button" data-tab="${tab.key}">
                ${tab.label}
              </button>
            `
          )
          .join("")}
      </div>
      <div class="workspace-layout">
        ${renderActiveTab(project, user, draft, assignedDisciplines)}
      </div>
    </section>
  `;
}

function renderActiveTab(project, user, draft, assignedDisciplines) {
  switch (state.ui.activeTab) {
    case "combined":
      return renderCombinedTab(project);
    case "byProject":
      return renderByProjectTab(project);
    case "visual":
      return renderVisualTab();
    case "data":
    default:
      return renderDataTab(project, user, draft, assignedDisciplines);
  }
}

function renderDataTab(project, user, draft, assignedDisciplines) {
  const editableItems = project.items.filter((item) => canEditLineItem(item, user, project));
  const items = [...editableItems].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const lineNumber = draft.id
    ? draft.lineNumber
    : nextLineNumber(project, draft.disciplineKey);

  return `
    <section class="split-layout">
      <div class="workspace-panel sticky">
        <div class="section-header">
          <div>
            <h3 class="panel-title">${draft.id ? "Edit line item" : "Add data"}</h3>
            <p class="panel-subtitle">Enter the discipline-specific option once, then let the combined and byProject views organize it downstream.</p>
          </div>
          ${draft.id ? `<button class="ghost-button" type="button" data-action="cancel-edit">Cancel edit</button>` : ""}
        </div>
        <form id="line-item-form" class="stack-form">
          <div class="helper-strip">
            <span><strong>Line #</strong> <span class="mono">${escapeHtml(lineNumber)}</span></span>
            <span><strong>Discipline</strong> ${escapeHtml(DISCIPLINE_MAP[draft.disciplineKey].label)}</span>
          </div>
          <div class="field-grid">
            <div class="field">
              <label for="disciplineKey">Discipline</label>
              <select id="disciplineKey" name="disciplineKey">
                ${assignedDisciplines.map(
                  (discipline) => `
                    <option value="${discipline.key}" ${draft.disciplineKey === discipline.key ? "selected" : ""}>${escapeHtml(discipline.label)}</option>
                  `
                ).join("")}
              </select>
            </div>
            <div class="field">
              <label for="linePreview">Auto number</label>
              <input id="linePreview" value="${escapeAttribute(lineNumber)}" disabled>
            </div>
          </div>
          <div class="field-full">
            <label for="lineName">Name / Short Description</label>
            <textarea id="lineName" name="name" placeholder="Summarize the intervention in one concise sentence.">${escapeHtml(draft.name)}</textarea>
          </div>
          <div class="field-grid three">
            ${renderSelectField("category", "Category", CATEGORY_OPTIONS, draft.category)}
            ${renderSelectField("timelinePriority", "Timeline Priority", TIMELINE_OPTIONS, draft.timelinePriority)}
            ${renderSelectField("buildingArea", "Building Area Impacted", BUILDING_AREA_OPTIONS, draft.buildingArea)}
            ${renderSelectField("buildingLevel", "Building Level Impacted", BUILDING_LEVEL_OPTIONS, draft.buildingLevel)}
            ${renderSelectField("operationalImpact", "Relative Operational Impact", IMPACT_OPTIONS, draft.operationalImpact)}
            ${renderSelectField("userBenefit", "Relative Benefit to Users", BENEFIT_OPTIONS, draft.userBenefit)}
            ${renderSelectField("publicBenefit", "Relative Benefit to Public", BENEFIT_OPTIONS, draft.publicBenefit)}
            ${renderSelectField("firstCost", "Relative First Cost", COST_OPTIONS, draft.firstCost)}
            ${renderSelectField("operationCostImpact", "Relative Operation Cost Impact", OPERATION_COST_OPTIONS, draft.operationCostImpact)}
            ${renderSelectField("energyImpact", "Operational Energy / Emissions", ENERGY_OPTIONS, draft.energyImpact)}
            ${renderSelectField("electrification", "Electrification / EO 594", ELECTRIFICATION_OPTIONS, draft.electrification)}
          </div>
          <div>
            <label style="display:block;margin-bottom:8px;font-weight:600;">Potential Synergies</label>
            <div class="chip-row">
              ${project.disciplines
                .filter((discipline) => discipline.key !== draft.disciplineKey)
                .map((discipline) => {
                  const active = draft.potentialSynergies.includes(discipline.key);
                  return `
                    <button
                      class="synergy-chip ${active ? "active" : ""}"
                      type="button"
                      data-toggle-synergy="${discipline.key}"
                    >
                      ${escapeHtml(discipline.label)}
                    </button>
                  `;
                })
                .join("")}
            </div>
          </div>
          <div class="checkbox-grid">
            ${BOOLEAN_FIELDS.map(
              (field) => `
                <label class="checkbox">
                  <input type="checkbox" name="${field.name}" ${draft[field.name] ? "checked" : ""}>
                  <span>${escapeHtml(field.label)}</span>
                </label>
              `
            ).join("")}
          </div>
          <div class="field-full">
            <label for="notes">Supporting Notes / Additional Info</label>
            <textarea id="notes" name="notes" placeholder="Add context, dependencies, assumptions, or follow-up notes.">${escapeHtml(draft.notes)}</textarea>
          </div>
          <div class="button-row">
            <button class="button" type="submit">${draft.id ? "Save changes" : "Add line item"}</button>
          </div>
        </form>
      </div>
      <div class="workspace-panel">
        <div class="section-header">
          <div>
            <h3 class="panel-title">Current line items</h3>
            <p class="panel-subtitle">Entries are grouped here as a working list for the logged-in user, with edit access for their assigned disciplines.</p>
          </div>
        </div>
        <div class="stats-row">
          <div class="stat-card">
            <strong>${project.items.length}</strong>
            Total items in project
          </div>
          <div class="stat-card">
            <strong>${items.length}</strong>
            Editable from this account
          </div>
          <div class="stat-card">
            <strong>${project.subprojects.length}</strong>
            Sub-projects using this data
          </div>
        </div>
        ${
          items.length
            ? `
              <div class="line-list">
                ${items.map((item) => renderEditableLineCard(item)).join("")}
              </div>
            `
            : renderEmptyState(
                "No line items yet",
                "Add the first item from the form to start building the shared matrix."
              )
        }
      </div>
    </section>
  `;
}

function renderCombinedTab(project) {
  const filters = state.ui.combinedFilters;
  const grouped = groupCombinedItems(project, filters);
  const activeDisciplineLabels = filters.disciplines.map((disciplineKey) => DISCIPLINE_MAP[disciplineKey].label).join(", ");

  return `
    <section class="combined-grid">
      <div class="panel sticky filter-panel">
        <div>
          <h3 class="panel-title">Combined matrix</h3>
          <p class="panel-subtitle">Group by discipline, then narrow the list with search, category, timeline, and trade filters.</p>
        </div>
        <div class="field-full">
          <label for="combined-search">Search</label>
          <input id="combined-search" value="${escapeAttribute(filters.search)}" placeholder="Search by line #, name, notes, or synergy">
        </div>
        <div class="field-grid">
          <div class="field">
            <label for="combined-category">Category</label>
            <select id="combined-category">
              <option value="all">All categories</option>
              ${CATEGORY_OPTIONS.map(
                (option) => `<option value="${option}" ${filters.category === option ? "selected" : ""}>${escapeHtml(option)}</option>`
              ).join("")}
            </select>
          </div>
          <div class="field">
            <label for="combined-timeline">Timeline</label>
            <select id="combined-timeline">
              <option value="all">All timeline priorities</option>
              ${TIMELINE_OPTIONS.map(
                (option) => `<option value="${option}" ${filters.timeline === option ? "selected" : ""}>${escapeHtml(option)}</option>`
              ).join("")}
            </select>
          </div>
        </div>
        <div class="field">
          <label for="combined-sort">Sort within groups</label>
          <select id="combined-sort">
            <option value="priority" ${filters.sort === "priority" ? "selected" : ""}>Priority first</option>
            <option value="cost" ${filters.sort === "cost" ? "selected" : ""}>Lower first cost first</option>
            <option value="alpha" ${filters.sort === "alpha" ? "selected" : ""}>Alphabetical</option>
            <option value="recent" ${filters.sort === "recent" ? "selected" : ""}>Recently updated</option>
          </select>
        </div>
        <div>
          <label style="display:block;margin-bottom:8px;font-weight:600;">Discipline filter</label>
          <div class="chip-row">
            ${project.disciplines.map(
              (discipline) => `
                <button
                  class="filter-chip ${filters.disciplines.includes(discipline.key) ? "active" : ""}"
                  type="button"
                  data-toggle-combined-discipline="${discipline.key}"
                >
                  ${escapeHtml(discipline.shortLabel)}
                </button>
              `
            ).join("")}
          </div>
          <p class="helper-text">${activeDisciplineLabels || "Showing all disciplines."}</p>
        </div>
        <div class="legend-panel">
          <h3 class="panel-title">Trade colors</h3>
          <div class="legend-row">
            ${project.disciplines.map(
              (discipline) => `
                <span class="legend-chip">
                  <span class="legend-swatch" style="background:${discipline.color}"></span>
                  ${escapeHtml(discipline.label)}
                </span>
              `
            ).join("")}
          </div>
        </div>
      </div>
      <div class="workspace-panel">
        <div class="section-header">
          <div>
            <h3 class="panel-title">Grouped line items</h3>
            <p class="panel-subtitle">${grouped.total} visible item${grouped.total === 1 ? "" : "s"} after filtering.</p>
          </div>
        </div>
        ${
          grouped.total
            ? grouped.groups
                .map(
                  (group) => `
                    <section class="group-card">
                      <div class="group-header" style="background:${group.discipline.color};">
                        <h3>${escapeHtml(group.discipline.label)}</h3>
                        <span class="pill">${group.items.length} item${group.items.length === 1 ? "" : "s"}</span>
                      </div>
                      <div class="group-body">
                        ${group.items.map((item) => renderCombinedLineCard(item)).join("")}
                      </div>
                    </section>
                  `
                )
                .join("")
            : renderEmptyState(
                "No matches for this filter set",
                "Relax a search term or switch off a discipline filter to see more of the combined matrix."
              )
        }
      </div>
    </section>
  `;
}

function renderByProjectTab(project) {
  const ui = state.ui.byProject;
  const libraryItems = filteredLibraryItems(project, ui.search);
  const targetOptions = project.subprojects.map((subproject) => ({
    value: subproject.id,
    label: `${subproject.code} · ${subproject.name}`,
  }));

  return `
    <section class="project-breakdown">
      <div class="panel sticky">
        <div class="section-header">
          <div>
            <h3 class="panel-title">byProject breakdown</h3>
            <p class="panel-subtitle">Create packaged sub-projects and pull in existing line items by search. The first package begins at PP10.</p>
          </div>
        </div>
        <form id="subproject-form" class="stack-form">
          <div class="field-full">
            <label for="subproject-name">New sub-project name</label>
            <input id="subproject-name" name="subprojectName" value="${escapeAttribute(ui.newName)}" placeholder="Parking garage improvements">
          </div>
          <div class="button-row">
            <button class="button" type="submit">Create sub-project</button>
          </div>
        </form>
        <div style="margin-top:18px;">
          <h3 class="panel-title">Line item library</h3>
          <p class="panel-subtitle">Search by line # or description, then add a result into a target package.</p>
          <div class="field-full" style="margin-top:14px;">
            <label for="byproject-search">Search items</label>
            <input id="byproject-search" value="${escapeAttribute(ui.search)}" placeholder="A1, HP4, garage, facade...">
          </div>
          <div class="field-full" style="margin-top:14px;">
            <label for="byproject-target">Target sub-project</label>
            <select id="byproject-target">
              <option value="">Select a sub-project</option>
              ${targetOptions.map(
                (option) => `
                  <option value="${option.value}" ${ui.targetSubprojectId === option.value ? "selected" : ""}>
                    ${escapeHtml(option.label)}
                  </option>
                `
              ).join("")}
            </select>
          </div>
          ${
            project.subprojects.length
              ? `
                <div class="library-list">
                  ${libraryItems.map((item) => renderLibraryCard(item, ui.targetSubprojectId)).join("")}
                </div>
              `
              : renderEmptyState(
                  "No sub-projects yet",
                  "Create a package first, then add line items from the searchable library."
                )
          }
        </div>
      </div>
      <div class="workspace-panel">
        <div class="section-header">
          <div>
            <h3 class="panel-title">Sub-project packages</h3>
            <p class="panel-subtitle">Each package preserves linked line-item data while adding a quantity field for estimating.</p>
          </div>
        </div>
        ${
          project.subprojects.length
            ? `
              <div class="subproject-stack">
                ${project.subprojects.map((subproject) => renderSubprojectCard(project, subproject)).join("")}
              </div>
            `
            : renderEmptyState(
                "No packages created",
                "Start with a named sub-project to break the combined matrix into actionable scopes."
              )
        }
      </div>
    </section>
  `;
}

function renderVisualTab() {
  return renderEmptyState(
    "Visual tab reserved",
    "This area is intentionally left open for the next phase, where sub-project packages can turn into a more graphical roadmap."
  );
}

function renderEditableLineCard(item) {
  const discipline = DISCIPLINE_MAP[item.disciplineKey];
  return `
    <article class="line-card" style="--brand:${discipline.color}">
      <div class="line-head">
        <div>
          <div class="line-title">
            <span class="line-number">${escapeHtml(item.lineNumber)}</span>
            <span class="legend-chip"><span class="legend-swatch" style="background:${discipline.color}"></span>${escapeHtml(discipline.label)}</span>
          </div>
          <h3>${escapeHtml(item.name || "Untitled item")}</h3>
          <div class="meta-row">
            <span class="pill">${escapeHtml(item.category)}</span>
            <span class="pill">${escapeHtml(item.timelinePriority)}</span>
            <span class="pill">${escapeHtml(item.firstCost)}</span>
          </div>
        </div>
        <button class="line-action" type="button" data-edit-item="${item.id}">Edit</button>
      </div>
      <div class="meta-row">
        <span class="tag">${escapeHtml(item.buildingArea)}</span>
        <span class="tag">${escapeHtml(item.buildingLevel)}</span>
      </div>
      ${item.notes ? `<p class="mini-note" style="margin-top:12px;">${escapeHtml(item.notes)}</p>` : ""}
    </article>
  `;
}

function renderCombinedLineCard(item) {
  const discipline = DISCIPLINE_MAP[item.disciplineKey];
  return `
    <article class="line-summary">
      <div class="line-title">
        <span class="line-number">${escapeHtml(item.lineNumber)}</span>
        <span class="legend-chip"><span class="legend-swatch" style="background:${discipline.color}"></span>${escapeHtml(item.category)}</span>
        <span class="pill">${escapeHtml(item.timelinePriority)}</span>
      </div>
      <h4>${escapeHtml(item.name || "Untitled item")}</h4>
      <div class="meta-row">
        <span class="pill">${escapeHtml(item.buildingArea)}</span>
        <span class="pill">${escapeHtml(item.firstCost)}</span>
        <span class="pill">${escapeHtml(item.operationalImpact)} operational impact</span>
      </div>
      ${
        item.potentialSynergies.length
          ? `<p class="mini-note">Synergies: ${item.potentialSynergies.map((disciplineKey) => DISCIPLINE_MAP[disciplineKey].shortLabel).join(", ")}</p>`
          : ""
      }
      ${item.notes ? `<p class="mini-note">${escapeHtml(item.notes)}</p>` : ""}
    </article>
  `;
}

function renderLibraryCard(item, targetSubprojectId) {
  const discipline = DISCIPLINE_MAP[item.disciplineKey];
  return `
    <article class="library-item">
      <div class="library-head">
        <div>
          <div class="line-title">
            <span class="line-number">${escapeHtml(item.lineNumber)}</span>
            <span class="legend-chip"><span class="legend-swatch" style="background:${discipline.color}"></span>${escapeHtml(discipline.label)}</span>
          </div>
          <strong>${escapeHtml(item.name)}</strong>
          <div class="meta-row">
            <span class="pill">${escapeHtml(item.category)}</span>
            <span class="pill">${escapeHtml(item.timelinePriority)}</span>
            <span class="pill">${escapeHtml(item.firstCost)}</span>
          </div>
        </div>
        <button
          class="button"
          type="button"
          data-add-to-subproject="${item.id}"
          ${targetSubprojectId ? "" : "disabled"}
        >
          Add
        </button>
      </div>
      ${item.notes ? `<p class="mini-note">${escapeHtml(item.notes)}</p>` : ""}
    </article>
  `;
}

function renderSubprojectCard(project, subproject) {
  const entries = subproject.items
    .map((entry) => ({
      entry,
      item: project.items.find((item) => item.id === entry.lineItemId),
    }))
    .filter((entry) => entry.item);

  return `
    <article class="subproject-card" style="--brand:${DISCIPLINE_MAP.architectural.color}">
      <div class="subproject-head">
        <div>
          <span class="subproject-code">${escapeHtml(subproject.code)}</span>
          <h3 style="margin-top:10px;">${escapeHtml(subproject.name)}</h3>
          <div class="meta-row">
            <span class="pill">${entries.length} linked item${entries.length === 1 ? "" : "s"}</span>
          </div>
        </div>
      </div>
      ${
        entries.length
          ? `
            <div class="subproject-item-list">
              ${entries
                .map(({ entry, item }) => {
                  const discipline = DISCIPLINE_MAP[item.disciplineKey];
                  return `
                    <article class="subproject-item">
                      <div class="subproject-item-top">
                        <div>
                          <div class="line-title">
                            <span class="line-number">${escapeHtml(item.lineNumber)}</span>
                            <span class="legend-chip"><span class="legend-swatch" style="background:${discipline.color}"></span>${escapeHtml(discipline.label)}</span>
                          </div>
                          <strong>${escapeHtml(item.name)}</strong>
                          <div class="meta-row">
                            <span class="pill">${escapeHtml(item.category)}</span>
                            <span class="pill">${escapeHtml(item.timelinePriority)}</span>
                            <span class="pill">${escapeHtml(item.firstCost)}</span>
                          </div>
                        </div>
                        <button class="ghost-button" type="button" data-remove-subproject-item="${subproject.id}|${item.id}">Remove</button>
                      </div>
                      <div class="field-grid">
                        <div class="inline-field">
                          <label>Quantities for estimation</label>
                          <input
                            class="quantity-input"
                            data-quantity-subproject="${subproject.id}"
                            data-quantity-item="${item.id}"
                            value="${escapeAttribute(entry.quantity || "")}"
                            placeholder="150 LF, 2 EA, 4,200 SF"
                          >
                        </div>
                        <div class="inline-field">
                          <label>Linked notes</label>
                          <div class="mini-note">${escapeHtml(item.notes || "No additional notes provided.")}</div>
                        </div>
                      </div>
                    </article>
                  `;
                })
                .join("")}
            </div>
          `
          : renderEmptyState("No line items linked", "Use the library on the left to search and add project options into this package.")
      }
    </article>
  `;
}

function renderSelectField(name, label, options, selected) {
  return `
    <div class="field">
      <label for="${name}">${escapeHtml(label)}</label>
      <select id="${name}" name="${name}">
        ${options.map((option) => `<option value="${option}" ${selected === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
      </select>
    </div>
  `;
}

function renderEmptyState(title, copy) {
  return `
    <div class="empty-panel">
      <div class="empty-mark">+</div>
      <h3 class="panel-title">${escapeHtml(title)}</h3>
      <p class="panel-subtitle" style="max-width:52ch;">${escapeHtml(copy)}</p>
    </div>
  `;
}

function groupCombinedItems(project, filters) {
  const search = filters.search.trim().toLowerCase();
  const groups = project.disciplines
    .map((discipline) => {
      let items = project.items.filter((item) => item.disciplineKey === discipline.key);
      if (filters.disciplines.length) {
        items = items.filter((item) => filters.disciplines.includes(item.disciplineKey));
      }
      if (filters.category !== "all") {
        items = items.filter((item) => item.category === filters.category);
      }
      if (filters.timeline !== "all") {
        items = items.filter((item) => item.timelinePriority === filters.timeline);
      }
      if (search) {
        items = items.filter((item) =>
          [item.lineNumber, item.name, item.notes, ...item.potentialSynergies.map((disciplineKey) => DISCIPLINE_MAP[disciplineKey].label)]
            .join(" ")
            .toLowerCase()
            .includes(search)
        );
      }
      items = sortItems(items, filters.sort);
      return { discipline, items };
    })
    .filter((group) => group.items.length);

  return {
    total: groups.reduce((total, group) => total + group.items.length, 0),
    groups,
  };
}

function filteredLibraryItems(project, searchValue) {
  const search = searchValue.trim().toLowerCase();
  const sorted = [...project.items].sort((a, b) => a.lineNumber.localeCompare(b.lineNumber));
  if (!search) return sorted;
  return sorted.filter((item) =>
    [item.lineNumber, item.name, item.notes].join(" ").toLowerCase().includes(search)
  );
}

function sortItems(items, sortMode) {
  const sorted = [...items];
  switch (sortMode) {
    case "alpha":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "cost":
      sorted.sort((a, b) => (COST_RANK[a.firstCost] || 0) - (COST_RANK[b.firstCost] || 0));
      break;
    case "recent":
      sorted.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      break;
    case "priority":
    default:
      sorted.sort((a, b) => (PRIORITY_RANK[a.timelinePriority] || 0) - (PRIORITY_RANK[b.timelinePriority] || 0));
      break;
  }
  return sorted;
}

function ensureLineItemDraft(project, assignedDisciplines) {
  if (!assignedDisciplines.length) {
    state.ui.lineItemDraft = createLineItemDraft("architectural");
    return;
  }

  const currentDraft = state.ui.lineItemDraft || createLineItemDraft(assignedDisciplines[0].key);
  const draftDisciplineIsValid = assignedDisciplines.some((discipline) => discipline.key === currentDraft.disciplineKey);
  if (!draftDisciplineIsValid) {
    state.ui.lineItemDraft = createLineItemDraft(assignedDisciplines[0].key);
    saveState();
  }

  if (state.ui.lineItemDraft.id && !project.items.some((item) => item.id === state.ui.lineItemDraft.id)) {
    state.ui.lineItemDraft = createLineItemDraft(assignedDisciplines[0].key);
    saveState();
  }
}

function nextLineNumber(project, disciplineKey, excludeItemId = "") {
  const discipline = DISCIPLINE_MAP[disciplineKey];
  const maxValue = project.items
    .filter((item) => item.disciplineKey === disciplineKey && item.id !== excludeItemId)
    .reduce((max, item) => {
      const numericPart = parseInt(item.lineNumber.replace(/[^\d]/g, ""), 10);
      return Number.isNaN(numericPart) ? max : Math.max(max, numericPart);
    }, 0);
  return `${discipline.code}${maxValue + 1}`;
}

function canEditLineItem(item, user, project) {
  if (user.role === "admin") return item.disciplineKey === "architectural";
  return allowedDisciplinesForProject(project, user).some((discipline) => discipline.key === item.disciplineKey);
}

function handleClick(event) {
  const fillLogin = event.target.closest("[data-fill-login]");
  if (fillLogin) {
    const email = fillLogin.dataset.fillLogin;
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");
    if (emailInput && passwordInput) {
      emailInput.value = email;
      passwordInput.value = "1234";
    }
    return;
  }

  const logoutButton = event.target.closest("[data-action='logout']");
  if (logoutButton) {
    state.sessionEmail = "";
    state.ui.activeProjectId = "";
    state.ui.activeTab = "data";
    state.ui.editingLineItemId = "";
    state.ui.loginError = "";
    saveState();
    render();
    return;
  }

  const backButton = event.target.closest("[data-action='back-dashboard']");
  if (backButton) {
    state.ui.activeProjectId = "";
    state.ui.activeTab = "data";
    state.ui.editingLineItemId = "";
    saveState();
    render();
    return;
  }

  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) {
    state.ui.activeTab = tabButton.dataset.tab;
    saveState();
    render();
    return;
  }

  const openProject = event.target.closest("[data-open-project]");
  if (openProject) {
    state.ui.activeProjectId = openProject.dataset.openProject;
    state.ui.activeTab = "data";
    state.ui.editingLineItemId = "";
    const user = currentUser();
    const project = activeProject(user) || accessibleProjects(user).find((entry) => entry.id === openProject.dataset.openProject);
    if (project) {
      const allowed = allowedDisciplinesForProject(project, user);
      const fallback = allowed[0]?.key || "architectural";
      state.ui.lineItemDraft = createLineItemDraft(fallback);
      state.ui.byProject.targetSubprojectId = project.subprojects[0]?.id || "";
    }
    saveState();
    render();
    return;
  }

  const toggleDiscipline = event.target.closest("[data-toggle-discipline]");
  if (toggleDiscipline) {
    const disciplineKey = toggleDiscipline.dataset.toggleDiscipline;
    const selected = new Set(state.ui.projectDraft.selectedDisciplines);
    if (selected.has(disciplineKey)) {
      selected.delete(disciplineKey);
    } else {
      selected.add(disciplineKey);
    }
    state.ui.projectDraft.selectedDisciplines = DISCIPLINES.filter((discipline) => selected.has(discipline.key)).map((discipline) => discipline.key);
    saveState();
    render();
    return;
  }

  const toggleSynergy = event.target.closest("[data-toggle-synergy]");
  if (toggleSynergy) {
    const disciplineKey = toggleSynergy.dataset.toggleSynergy;
    const current = new Set(state.ui.lineItemDraft.potentialSynergies);
    if (current.has(disciplineKey)) {
      current.delete(disciplineKey);
    } else {
      current.add(disciplineKey);
    }
    state.ui.lineItemDraft.potentialSynergies = Array.from(current);
    saveState();
    render();
    return;
  }

  const toggleCombinedDiscipline = event.target.closest("[data-toggle-combined-discipline]");
  if (toggleCombinedDiscipline) {
    const disciplineKey = toggleCombinedDiscipline.dataset.toggleCombinedDiscipline;
    const selected = new Set(state.ui.combinedFilters.disciplines);
    if (selected.has(disciplineKey)) {
      selected.delete(disciplineKey);
    } else {
      selected.add(disciplineKey);
    }
    state.ui.combinedFilters.disciplines = Array.from(selected);
    saveState();
    render();
    return;
  }

  const editItemButton = event.target.closest("[data-edit-item]");
  if (editItemButton) {
    const user = currentUser();
    const project = activeProject(user);
    if (!project) return;
    const item = project.items.find((entry) => entry.id === editItemButton.dataset.editItem);
    if (!item) return;
    state.ui.lineItemDraft = { ...createLineItemDraft(item.disciplineKey), ...item, potentialSynergies: [...item.potentialSynergies] };
    state.ui.activeTab = "data";
    state.ui.editingLineItemId = item.id;
    saveState();
    render();
    return;
  }

  const cancelEdit = event.target.closest("[data-action='cancel-edit']");
  if (cancelEdit) {
    const user = currentUser();
    const project = activeProject(user);
    if (!project) return;
    const allowed = allowedDisciplinesForProject(project, user);
    state.ui.lineItemDraft = createLineItemDraft(allowed[0]?.key || "architectural");
    state.ui.editingLineItemId = "";
    saveState();
    render();
    return;
  }

  const loadDemoButton = event.target.closest("[data-action='load-demo']");
  if (loadDemoButton) {
    const demo = buildDemoProject();
    const existing = state.projects.find((project) => project.name === demo.name);
    if (!existing) {
      state.projects.unshift(demo);
      state.ui.activeProjectId = demo.id;
    } else {
      state.ui.activeProjectId = existing.id;
    }
    state.ui.activeTab = "data";
    const user = currentUser();
    const project = activeProject(user) || demo;
    const allowed = allowedDisciplinesForProject(project, user);
    state.ui.lineItemDraft = createLineItemDraft(allowed[0]?.key || "architectural");
    state.ui.byProject.targetSubprojectId = project.subprojects[0]?.id || "";
    saveState();
    render();
    return;
  }

  const addToSubprojectButton = event.target.closest("[data-add-to-subproject]");
  if (addToSubprojectButton) {
    const user = currentUser();
    const project = activeProject(user);
    if (!project || !state.ui.byProject.targetSubprojectId) return;
    const subproject = project.subprojects.find((entry) => entry.id === state.ui.byProject.targetSubprojectId);
    if (!subproject) return;
    const lineItemId = addToSubprojectButton.dataset.addToSubproject;
    if (!subproject.items.some((entry) => entry.lineItemId === lineItemId)) {
      subproject.items.push({ lineItemId, quantity: "" });
      saveState();
      render();
    }
    return;
  }

  const removeSubprojectItemButton = event.target.closest("[data-remove-subproject-item]");
  if (removeSubprojectItemButton) {
    const [subprojectId, lineItemId] = removeSubprojectItemButton.dataset.removeSubprojectItem.split("|");
    const user = currentUser();
    const project = activeProject(user);
    if (!project) return;
    const subproject = project.subprojects.find((entry) => entry.id === subprojectId);
    if (!subproject) return;
    subproject.items = subproject.items.filter((entry) => entry.lineItemId !== lineItemId);
    saveState();
    render();
  }
}

function handleSubmit(event) {
  event.preventDefault();
  const form = event.target;

  if (form.id === "login-form") {
    const email = form.email.value.trim().toLowerCase();
    const password = form.password.value.trim();
    const user = USERS.find((entry) => entry.email === email && entry.password === password);
    if (!user) {
      state.ui.loginError = "Use one of the seeded accounts and password 1234.";
      saveState();
      render();
      return;
    }
    state.sessionEmail = user.email;
    state.ui.loginError = "";
    state.ui.activeProjectId = "";
    state.ui.activeTab = "data";
    state.ui.editingLineItemId = "";
    saveState();
    render();
    return;
  }

  if (form.id === "project-create-form") {
    const draft = state.ui.projectDraft;
    if (!draft.name.trim()) {
      window.alert("Add a project name first.");
      return;
    }

    const disciplines = [
      {
        ...DISCIPLINE_MAP.architectural,
        orgName: "Finegold Alexander",
        email: "admin@gmail.com",
      },
      ...draft.selectedDisciplines.map((disciplineKey) => ({
        ...DISCIPLINE_MAP[disciplineKey],
        orgName: (draft.contacts[disciplineKey]?.orgName || "").trim() || DISCIPLINE_MAP[disciplineKey].label,
        email: (draft.contacts[disciplineKey]?.email || "").trim(),
      })),
    ];

    const project = {
      id: createId("project"),
      name: draft.name.trim(),
      createdAt: new Date().toISOString(),
      disciplines,
      items: [],
      subprojects: [],
    };

    state.projects.unshift(project);
    state.ui.projectDraft = createProjectDraft();
    state.ui.activeProjectId = project.id;
    state.ui.activeTab = "data";
    state.ui.editingLineItemId = "";
    state.ui.lineItemDraft = createLineItemDraft("architectural");
    state.ui.byProject = { ...state.ui.byProject, targetSubprojectId: "" };
    saveState();
    render();
    return;
  }

  if (form.id === "line-item-form") {
    const user = currentUser();
    const project = activeProject(user);
    if (!project) return;
    const draft = { ...state.ui.lineItemDraft };
    const isEditing = Boolean(draft.id);
    const lineNumber = isEditing && draft.lineNumber ? draft.lineNumber : nextLineNumber(project, draft.disciplineKey, draft.id);

    const payload = {
      ...draft,
      id: draft.id || createId("item"),
      lineNumber,
      name: draft.name.trim(),
      updatedAt: new Date().toISOString(),
      createdBy: user.email,
    };

    if (!payload.name) {
      window.alert("Add a name or short description for the line item.");
      return;
    }

    const existingIndex = project.items.findIndex((item) => item.id === payload.id);
    if (existingIndex >= 0) {
      project.items[existingIndex] = payload;
    } else {
      project.items.push(payload);
    }

    state.ui.lineItemDraft = createLineItemDraft(draft.disciplineKey);
    state.ui.editingLineItemId = "";
    saveState();
    render();
    return;
  }

  if (form.id === "subproject-form") {
    const user = currentUser();
    const project = activeProject(user);
    if (!project) return;
    const name = state.ui.byProject.newName.trim();
    if (!name) {
      window.alert("Name the sub-project before creating it.");
      return;
    }
    const subproject = {
      id: createId("subproject"),
      code: nextSubprojectCode(project),
      name,
      items: [],
      createdAt: new Date().toISOString(),
    };
    project.subprojects.push(subproject);
    state.ui.byProject.newName = "";
    state.ui.byProject.targetSubprojectId = subproject.id;
    saveState();
    render();
  }
}

function handleInput(event) {
  const target = event.target;

  if (target.closest("#project-create-form")) {
    if (target.name === "projectName") {
      state.ui.projectDraft.name = target.value;
    }
    if (target.dataset.contactOrg) {
      state.ui.projectDraft.contacts[target.dataset.contactOrg].orgName = target.value;
    }
    if (target.dataset.contactEmail) {
      state.ui.projectDraft.contacts[target.dataset.contactEmail].email = target.value;
    }
    saveState();
    return;
  }

  if (target.closest("#line-item-form")) {
    const { name, type, checked, value } = target;
    if (!name) return;
    state.ui.lineItemDraft[name] = type === "checkbox" ? checked : value;
    saveState();
    return;
  }

  if (target.closest("#subproject-form") && target.name === "subprojectName") {
    state.ui.byProject.newName = target.value;
    saveState();
    return;
  }

  if (target.id === "combined-search") {
    state.ui.combinedFilters.search = target.value;
    saveState();
    render();
    return;
  }

  if (target.id === "byproject-search") {
    state.ui.byProject.search = target.value;
    saveState();
    render();
    return;
  }

  if (target.dataset.quantitySubproject && target.dataset.quantityItem) {
    const user = currentUser();
    const project = activeProject(user);
    if (!project) return;
    const subproject = project.subprojects.find((entry) => entry.id === target.dataset.quantitySubproject);
    if (!subproject) return;
    const item = subproject.items.find((entry) => entry.lineItemId === target.dataset.quantityItem);
    if (!item) return;
    item.quantity = target.value;
    saveState();
  }
}

function handleChange(event) {
  const target = event.target;

  if (target.closest("#line-item-form") && target.name === "disciplineKey") {
    const user = currentUser();
    const project = activeProject(user);
    if (!project) return;
    const nextDraft = { ...state.ui.lineItemDraft };
    nextDraft.disciplineKey = target.value;
    nextDraft.lineNumber = nextLineNumber(project, target.value, nextDraft.id);
    nextDraft.potentialSynergies = nextDraft.potentialSynergies.filter((disciplineKey) => disciplineKey !== target.value);
    state.ui.lineItemDraft = nextDraft;
    saveState();
    render();
    return;
  }

  if (target.id === "combined-category") {
    state.ui.combinedFilters.category = target.value;
    saveState();
    render();
    return;
  }

  if (target.id === "combined-timeline") {
    state.ui.combinedFilters.timeline = target.value;
    saveState();
    render();
    return;
  }

  if (target.id === "combined-sort") {
    state.ui.combinedFilters.sort = target.value;
    saveState();
    render();
    return;
  }

  if (target.id === "byproject-target") {
    state.ui.byProject.targetSubprojectId = target.value;
    saveState();
    render();
  }
}

function nextSubprojectCode(project) {
  const max = project.subprojects.reduce((highest, subproject) => {
    const numeric = parseInt(subproject.code.replace(/[^\d]/g, ""), 10);
    return Number.isNaN(numeric) ? highest : Math.max(highest, numeric);
  }, 0);
  return `PP${String(max ? max + 10 : 10)}`;
}

function buildDemoProject() {
  const project = {
    id: createId("project"),
    name: "Beacon Campus Renewal",
    createdAt: new Date().toISOString(),
    disciplines: [
      { ...DISCIPLINE_MAP.architectural, orgName: "Finegold Alexander", email: "admin@gmail.com" },
      { ...DISCIPLINE_MAP.mechanical, orgName: "Atelier Systems", email: "consultant1@gmail.com" },
      { ...DISCIPLINE_MAP.electrical, orgName: "Atelier Systems", email: "consultant1@gmail.com" },
      { ...DISCIPLINE_MAP.historicPreservation, orgName: "Heritage Studio", email: "consultant2@gmail.com" },
      { ...DISCIPLINE_MAP.landscape, orgName: "Heritage Studio", email: "consultant2@gmail.com" },
      { ...DISCIPLINE_MAP.structural, orgName: "North Frame", email: "consultant1@gmail.com" },
      { ...DISCIPLINE_MAP.envelope, orgName: "North Frame", email: "consultant2@gmail.com" },
    ],
    items: [],
    subprojects: [],
  };

  const demoItems = [
    {
      disciplineKey: "architectural",
      name: "Refresh the Ashburton passage with coordinated finishes, lighting, and wayfinding.",
      category: "DEFERRED MAINTENANCE",
      timelinePriority: "1_HIGH <5 years",
      buildingArea: "ANNEX",
      buildingLevel: "L1",
      operationalImpact: "MODERATE",
      userBenefit: "HIGH",
      publicBenefit: "MODERATE",
      firstCost: "$ LOW",
      operationCostImpact: "N/A",
      energyImpact: "N/A",
      electrification: "NONE",
      resiliency: false,
      deferredMaintenance: true,
      codeLifeSafety: false,
      accessibilityImprovement: false,
      historicImpact: true,
      potentialSynergies: ["historicPreservation", "electrical"],
      notes: "This scope works best if wayfinding and facade lighting are coordinated in the same package.",
    },
    {
      disciplineKey: "mechanical",
      name: "Replace damaged pipe insulation and recommission toilet exhaust systems.",
      category: "DEFERRED MAINTENANCE",
      timelinePriority: "1_HIGH <5 years",
      buildingArea: "WHOLE BUILDING",
      buildingLevel: "WHOLE BUILDING",
      operationalImpact: "LOW",
      userBenefit: "MODERATE",
      publicBenefit: "NONE",
      firstCost: "$ LOW",
      operationCostImpact: "MODERATE REDUCTION",
      energyImpact: "MODERATE REDUCTION",
      electrification: "LOW",
      resiliency: true,
      deferredMaintenance: true,
      codeLifeSafety: false,
      accessibilityImprovement: false,
      historicImpact: false,
      potentialSynergies: ["electrical", "structural"],
      notes: "Existing conditions suggest a cluster of relatively quick wins with strong maintenance value.",
    },
    {
      disciplineKey: "electrical",
      name: "Upgrade interior lighting to all LED with layered controls in public areas.",
      category: "UPGRADES / IMPROVEMENTS",
      timelinePriority: "1_HIGH <5 years",
      buildingArea: "WHOLE BUILDING",
      buildingLevel: "WHOLE BUILDING",
      operationalImpact: "HIGH",
      userBenefit: "HIGH",
      publicBenefit: "HIGH",
      firstCost: "$$ MODERATE",
      operationCostImpact: "MODERATE REDUCTION",
      energyImpact: "MODERATE REDUCTION",
      electrification: "HIGH",
      resiliency: true,
      deferredMaintenance: false,
      codeLifeSafety: true,
      accessibilityImprovement: true,
      historicImpact: true,
      potentialSynergies: ["architectural", "historicPreservation"],
      notes: "Use mockups in public rooms to test color temperature against historic finishes before full rollout.",
    },
    {
      disciplineKey: "historicPreservation",
      name: "Restore masonry patchwork at the west facade and align repair standards campus-wide.",
      category: "RESTORATION *",
      timelinePriority: "2_MID 5-10 years",
      buildingArea: "WEST WING",
      buildingLevel: "ENVELOPE (EXT. WALLS)",
      operationalImpact: "LOW",
      userBenefit: "LOW",
      publicBenefit: "HIGH",
      firstCost: "$$ MODERATE",
      operationCostImpact: "N/A",
      energyImpact: "N/A",
      electrification: "NONE",
      resiliency: false,
      deferredMaintenance: true,
      codeLifeSafety: false,
      accessibilityImprovement: false,
      historicImpact: true,
      potentialSynergies: ["envelope", "architectural"],
      notes: "Pairs well with a facade access package and envelope investigation campaign.",
    },
    {
      disciplineKey: "landscape",
      name: "Reframe the front entry with accessible site circulation and stormwater planting zones.",
      category: "UPGRADES / IMPROVEMENTS",
      timelinePriority: "2_MID 5-10 years",
      buildingArea: "SITE",
      buildingLevel: "OTHER *",
      operationalImpact: "LOW",
      userBenefit: "HIGH",
      publicBenefit: "HIGH",
      firstCost: "$$ MODERATE",
      operationCostImpact: "MINIMAL IMPACT",
      energyImpact: "N/A",
      electrification: "NONE",
      resiliency: true,
      deferredMaintenance: false,
      codeLifeSafety: false,
      accessibilityImprovement: true,
      historicImpact: true,
      potentialSynergies: ["architectural"],
      notes: "Use this as a visible early public-facing phase with strong accessibility benefits.",
    },
  ];

  demoItems.forEach((item) => {
    const payload = {
      ...createLineItemDraft(item.disciplineKey),
      ...item,
      id: createId("item"),
      lineNumber: nextLineNumber(project, item.disciplineKey),
      createdBy: project.disciplines.find((discipline) => discipline.key === item.disciplineKey)?.email || "admin@gmail.com",
      updatedAt: new Date().toISOString(),
    };
    project.items.push(payload);
  });

  project.subprojects = [
    {
      id: createId("subproject"),
      code: "PP10",
      name: "Garage and systems quick wins",
      createdAt: new Date().toISOString(),
      items: [
        { lineItemId: project.items[1].id, quantity: "1 LS" },
        { lineItemId: project.items[2].id, quantity: "Phase 1 zones" },
      ],
    },
    {
      id: createId("subproject"),
      code: "PP20",
      name: "Public realm and facade refresh",
      createdAt: new Date().toISOString(),
      items: [
        { lineItemId: project.items[0].id, quantity: "1 corridor package" },
        { lineItemId: project.items[3].id, quantity: "West facade campaign" },
        { lineItemId: project.items[4].id, quantity: "Entry landscape package" },
      ],
    },
  ];

  return project;
}

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
