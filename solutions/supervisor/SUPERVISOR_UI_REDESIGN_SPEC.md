# Supervisor Web UI Redesign Programming Specification

**Document Type:** Programming Specification  
**Source:** `sscma-example-sg200x/solutions/supervisor/ui_update_spec.md`  
**Status:** UI-Only Implementation  

---

## 1. Overview

### 1.1 Summary
Redesign the Supervisor web UI to match the look and feel of the primary brand site (The Police Record / TPR) to improve brand continuity across devices (mobile + desktop). This is a **UI-only** effort with **no backend or frontend logic changes** beyond what is strictly required to apply new styling and layout.

### 1.2 Goals
- Make the Supervisor UI visually consistent with the main site (colors, typography, spacing, components, voice)
- Improve perceived quality and usability on small screens and desktop screens without changing feature behavior
- Ensure the UI works fully **offline** (no required external CSS/fonts/images/CDNs)

### 1.3 Non-Goals / Constraints
- Do not change backend (Go) logic or API behavior
- Do not change frontend business logic (data fetching, store shape, auth flow, route structure, API endpoints)
- `TPR.css` in `solutions/supervisor/TPR.css` is **reference only** and **must not ship** in compiled output
- Avoid introducing runtime dependencies on third-party CDNs or external fonts

---

## 2. Current Implementation

### 2.1 Technology Stack
| Component | Technology |
|-----------|------------|
| Build Tool | Vite |
| Framework | React + TypeScript |
| Styling | TailwindCSS |
| UI Libraries | antd / antd-mobile |
| State Management | Zustand |
| Routing | Hash Router (`createHashRouter`) |

### 2.2 Source Locations
| Item | Path |
|------|------|
| Frontend Source | `sscma-example-sg200x/solutions/supervisor/www/` |
| Entry HTML | `sscma-example-sg200x/solutions/supervisor/www/index.html` |
| Main Entry | `src/main.tsx` → `src/App.tsx` |
| UI Source | `sscma-example-sg200x/solutions/supervisor/www/src/` |

### 2.3 Serving Model
- Backend serves static files from `SUPERVISOR_ROOT_DIR` (default `/usr/share/supervisor/www/`)
- The UI refresh must keep the current supervisor web root/paths intact
- No re-homing of files or changing served locations

### 2.4 Out of Scope
- Deployment to end users (how artifacts are packaged/installed onto devices)

---

## 3. Brand Reference Inputs

### 3.1 CSS Reference File
- Location: `sscma-example-sg200x/solutions/supervisor/TPR.css`
- Purpose: Guide for brand styling patterns
- Current external references (example patterns):
  - `https://cdn.thepolicerecord.com/...`
  - `https://dev.thepolicerecord.com/...`

### 3.2 Offline Asset Policy
- All assets referenced by the redesigned UI (images, icons, fonts) must be included in the repository
- Assets must be bundled into the built `dist/` output
- No runtime fetching of brand assets from the internet

---

## 4. Design Direction

### 4.1 Look & Feel Requirements
Adopt TPR-like styling for:
- Color system (primary, background surfaces, neutral text scale, error/warn states)
- Typography scale and weight hierarchy
- Card/surface styling, shadows, borders, rounding
- Button styling and form field treatments
- Navigation/header treatments and spacing rhythm

### 4.2 Responsive Behavior
- Maintain existing "mobile vs PC layout" intent found under `src/layout/`
- Mobile-first layout with touch-friendly sizing
- Desktop layout with appropriate use of space and clearer information hierarchy

---

## 5. UI Architecture Plan

### 5.1 Styling Approach
| Approach | Details |
|----------|---------|
| Primary System | TailwindCSS for layout/styling |
| Theme Tokens | Update `www/tailwind.config.js` with brand colors, typography, spacing scales |
| CSS Variables | Use for theme primitives (e.g., `--color-bg`, `--color-surface`, `--color-text`) mapped into Tailwind |
| Global CSS | Minimal usage in `www/src/assets/style/index.css` for base/background, typography defaults, ant resets |

### 5.2 Component Strategy
- Re-skin existing components and pages; do not rewrite flows
- Introduce a small set of "brand wrappers" (UI-only components) if needed:
  - `BrandHeader`
  - `BrandCard`
  - `BrandButton`
- Keep props and usage identical where possible to avoid logic changes

### 5.3 Ant Design Theming
- Align antd token theming with brand palette
- Update `ConfigProvider` theme tokens (already present in `src/App.tsx`)
- Ensure contrast and accessibility for text on primary backgrounds

---

## 6. Offline Asset Plan

### 6.1 Inventory External References
Scan for `http(s)://` and `url(` in:
- `solutions/supervisor/TPR.css`
- `solutions/supervisor/www/src/**`

Produce a list of:
- External images
- External fonts (if any)
- Any other CDN references

### 6.2 Download and Store Locally
Add assets to the frontend under:
| Location | Usage |
|----------|-------|
| `www/public/` | Copied as-is by Vite, stable URL paths |
| `www/src/assets/` | Bundled and hashed by Vite when imported |

**Recommendation:** Prefer `public/brand/...` for direct CSS `url(...)` usage without import churn

### 6.3 Reference Replacement
Replace external `url(https://...)` with local `url(/brand/...)` or equivalent relative paths depending on `base`

### 6.4 Base Path Considerations
- Use asset paths that work with the supervisor's current static file root (`SUPERVISOR_ROOT_DIR`)
- Do not require changing where files are served from
- Prefer relative asset references where feasible

---

## 7. Scope of Visual Updates

### 7.1 Pages/Areas
UI changes apply across all screens without changing behavior:

| Area | Source Location |
|------|-----------------|
| Login | `src/views/login` |
| Overview | `src/views/overview` |
| Network | `src/views/network` |
| Files | `src/views/files` |
| Terminal | `src/views/terminal` |
| System | `src/views/system` |
| Security | `src/views/security` |
| Power | `src/views/power` |
| Dashboard wrapper | `src/views/dashboard` |
| Mobile layout shells | `src/layout/mobile/*` |
| PC layout shells | `src/layout/pc/*` |
| Common components | `src/components/*` |

---

## 8. Implementation Phases

### Phase 0: Research (How It Works)
1. **Map navigation + layout structure:**
   - Identify where header/nav/sidebar are rendered (mobile + PC)
   - Identify global containers (page padding, max widths, background surfaces)

2. **Catalog reused components and style entry points:**
   - Ant components used commonly (Buttons, Forms, Lists, Tabs, Popup/Modal)
   - Tailwind conventions and existing tokens
   - Confirm the primary UI organization under `www/src/`

3. **Create external dependency list:**
   - Document all assets and URLs requiring localization

### Phase 1: Define the Brand System (Tokens)
1. Create/update Tailwind theme tokens:
   - Colors
   - Border radii
   - Shadows
   - Spacing

2. Define typography rules:
   - Sizes
   - Weights
   - Line heights

3. Define core surfaces:
   - App background
   - Page surface
   - Card surface
   - Elevated surface (modal/popup)

### Phase 2: Layout + Navigation Reskin
1. Mobile header/sidebar reskin:
   - Spacing
   - Icons
   - Backgrounds

2. Desktop layout reskin:
   - Left nav
   - Top bar
   - Content container

3. Ensure consistent:
   - Page titles
   - Breadcrumbs (if present)
   - Section spacing

### Phase 3: Component Reskin
1. Form elements:
   - Buttons
   - Inputs
   - Selects
   - Toggles

2. Display elements:
   - Lists
   - Cards
   - Tabs

3. Overlay elements:
   - Popups/modals to match brand

4. State elements:
   - Loading states
   - Empty states
   - Error states

### Phase 4: Page-by-page Visual Polish
1. Apply consistent hero/intro sections where appropriate
2. Harmonize spacing and information density per page
3. Ensure camera streaming/preview area (if present) looks integrated

### Phase 5: Offline Assets + Hardening
1. Download and vendor any brand assets referenced by CSS
2. Replace external references with local paths
3. Build and verify the resulting `dist/` contains everything required

---

## 9. Acceptance Criteria

| Criterion | Requirement |
|-----------|-------------|
| Visual Consistency | UI visually matches the main brand direction (TPR-like) across mobile and desktop |
| Offline Capability | No runtime dependency on external assets (fonts/images/CSS) to render correctly |
| Logic Preservation | No changes to API behavior, auth flow, or feature behavior (UI-only changes) |
| Path Preservation | Current supervisor static file serving locations/paths remain intact (served from `SUPERVISOR_ROOT_DIR`) |

---

## 10. Deliverables

| Deliverable | Location |
|-------------|----------|
| Updated UI styling and layout | `sscma-example-sg200x/solutions/supervisor/www/` |
| Locally vendored asset set | Inside the frontend project |
| Original spec document | `sscma-example-sg200x/solutions/supervisor/ui_update_spec.md` |

---

## 11. File Structure Reference

```
sscma-example-sg200x/solutions/supervisor/
├── TPR.css                    # Brand reference (DO NOT SHIP)
├── ui_update_spec.md          # Original spec document
└── www/
    ├── index.html             # Entry HTML
    ├── tailwind.config.js     # Tailwind configuration (UPDATE)
    ├── public/
    │   └── brand/             # Local brand assets (CREATE)
    └── src/
        ├── main.tsx           # Main entry
        ├── App.tsx            # App component (ConfigProvider theming)
        ├── assets/
        │   └── style/
        │       └── index.css  # Global CSS (UPDATE)
        ├── components/        # Common components (RESKIN)
        ├── layout/
        │   ├── mobile/        # Mobile layout shells (RESKIN)
        │   └── pc/            # PC layout shells (RESKIN)
        └── views/
            ├── login/         # Login page (RESKIN)
            ├── overview/      # Overview page (RESKIN)
            ├── network/       # Network page (RESKIN)
            ├── files/         # Files page (RESKIN)
            ├── terminal/      # Terminal page (RESKIN)
            ├── system/        # System page (RESKIN)
            ├── security/      # Security page (RESKIN)
            ├── power/         # Power page (RESKIN)
            └── dashboard/     # Dashboard wrapper (RESKIN)
```

---

## 12. Technical Notes

### 12.1 Hash Router
The application uses `createHashRouter` for static hosting compatibility. This should not be changed.

### 12.2 Vite Build
- Assets in `public/` are copied as-is with stable URL paths
- Assets in `src/assets/` are bundled and hashed when imported
- The `dist/` output must be self-contained

### 12.3 Ant Design Integration
- `ConfigProvider` theme tokens are already present in `src/App.tsx`
- Update these tokens to match the brand system
- Both antd and antd-mobile are in use

### 12.4 Zustand State
- State management via Zustand should not be modified
- UI changes are purely presentational
