# Classroom Screen Awareness Design Guidelines

## Design Approach

**Selected Framework:** Material Design-inspired system with educational software considerations

**Justification:** This is a data-dense, utility-focused application requiring clear information hierarchy, real-time status visualization, and accessibility for teachers using various devices. The design prioritizes functional clarity, quick scanning, and trust-building through transparency.

**Core Principles:**
- Information clarity over aesthetic flourish
- Status visibility at a glance
- Privacy-first messaging and transparency
- Responsive adaptability for teacher devices
- Minimal cognitive load for monitoring tasks

---

## Typography System

**Font Stack:** Google Fonts via CDN
- Primary: Inter (400, 500, 600, 700) - for UI elements, labels, data
- Monospace: JetBrains Mono (400, 500) - for URLs, device IDs, technical data

**Hierarchy:**
- Page Headers: text-2xl font-semibold (Dashboard, Class Roster, Settings)
- Section Headers: text-lg font-semibold (Student List, Active Now)
- Card Titles: text-base font-medium (Student names)
- Body Text: text-sm font-normal (Tab titles, URLs, timestamps)
- Labels/Meta: text-xs font-medium uppercase tracking-wide (Status labels, categories)
- Technical Data: text-sm font-mono (Device IDs, URLs, timestamps)

---

## Layout System

**Spacing Primitives:** Tailwind units of 2, 4, 6, 8, 12, 16
- Micro spacing: p-2, gap-2 (within components)
- Standard spacing: p-4, gap-4 (between related elements)
- Section spacing: p-6, gap-6 (card padding, form sections)
- Major spacing: p-8, gap-8 (page margins, major sections)
- Extra spacing: p-12, gap-12 (section separation on dashboard)

**Grid Layouts:**
- Student Tiles: grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4
- Settings Forms: max-w-3xl single column
- Class Roster Table: w-full with responsive scroll

**Container Strategy:**
- Dashboard: max-w-screen-2xl mx-auto px-6 py-8
- Settings/Detail Pages: max-w-4xl mx-auto px-6 py-8
- Extension Popup: Fixed 320px width, min-h-400px

---

## Component Library

### Teacher Dashboard Components

**Student Tile Card:**
- Rounded corners: rounded-lg
- Border: border-2 (status-dependent thickness/style)
- Padding: p-4
- Shadow: shadow-sm hover:shadow-md transition
- Layout: Vertical stack with header (name + device ID), body (tab info), footer (timestamp)
- Status Indicator: Dot (h-3 w-3 rounded-full) positioned top-right
- Favicon: 16x16 inline with tab title
- URL Display: truncate text-sm font-mono with tooltip on hover

**Status States (visual only, no colors):**
- Online: Solid border, full opacity, pulsing dot
- Idle: Dashed border, 80% opacity, static dot  
- Offline: Thin border, 60% opacity, hollow dot
- Sharing: Double border, glow effect, animated icon

**Navigation Header:**
- Sticky positioning: sticky top-0 z-50
- Height: h-16
- Padding: px-6 py-4
- Layout: Flex justify-between items-center
- Left: Logo + app title
- Right: Navigation links + user menu dropdown
- Divider: border-b

**Data Table (Roster View):**
- Header: sticky top-16 with background
- Row height: h-12
- Cell padding: px-4 py-3
- Borders: border-b on rows
- Hover state: Subtle background change
- Sortable columns: Icon indicators
- Columns: Name, Device ID, Class, Current Tab, Last Seen, Actions

**Detail Drawer (Student Detail):**
- Width: w-96 on desktop, full-width on mobile
- Position: Fixed right-0 with slide-in animation
- Shadow: shadow-2xl
- Sections: Student info header, URL history list (scrollable max-h-96), WebRTC viewer container (16:9 aspect ratio), close button

### Chrome Extension UI

**Popup Layout (320px fixed width):**
- Header section: p-4 with school logo + name
- Banner: p-3 with icon + disclosure message ("Monitoring in effect")
- Status section: p-4 with connection status, last sync time
- Share section: p-4 with prominent share button + sharing indicator
- Footer: p-3 with "What's collected?" link

**Monitoring Banner:**
- Border-l-4 for visual emphasis
- Icon: 20x20 alert/info icon (Heroicons)
- Text: text-sm with semibold heading + regular description
- Spacing: gap-3 between icon and text

**Share Button (Not Sharing State):**
- Full width: w-full
- Padding: py-3 px-4
- Rounded: rounded-lg
- Font: text-sm font-semibold
- Icon: Screen/monitor icon 20x20 positioned left
- Spacing: gap-2 between icon and text

**Sharing Indicator (Active State):**
- Border: border-2 rounded-lg p-3
- Layout: Flex with pulsing dot + text + stop button
- Dot: h-3 w-3 rounded-full animate-pulse
- Stop Button: Secondary style, ml-auto

**Info/Settings Views:**
- Simple list layout with dividers
- Item padding: py-3 px-4
- Icons: 16x16 (Heroicons) aligned left
- Text hierarchy: font-medium label, text-sm value

### Settings & Admin Pages

**Form Sections:**
- Section spacing: space-y-8
- Section headers: pb-2 border-b mb-4
- Form groups: space-y-4
- Label: text-sm font-medium mb-1.5 block
- Input: p-2.5 rounded-md border w-full
- Help text: text-xs mt-1.5

**CSV Upload Component:**
- Dropzone: border-2 border-dashed rounded-lg p-8
- Icon: Upload icon 48x48 centered
- Text: Centered, text-sm with action text semibold
- File list: mt-4 space-y-2 with file items (name, size, remove button)

**Action Buttons:**
- Primary: py-2.5 px-4 rounded-md font-medium
- Secondary: py-2 px-3 rounded-md font-normal border
- Destructive: py-2 px-3 rounded-md font-medium
- Icon buttons: p-2 rounded-md (24x24 icon)

### Real-time & WebRTC Components

**WebRTC Video Viewer:**
- Container: aspect-video rounded-lg overflow-hidden
- Video: w-full h-full object-contain
- Overlay controls: Absolute positioned bottom with gradient backdrop
- Controls: Flex gap-2 p-4 (fullscreen, pip, stop buttons)

**Toast Notifications (Real-time updates):**
- Fixed bottom-4 right-4
- Max-width: max-w-sm
- Padding: p-4 rounded-lg
- Shadow: shadow-lg
- Layout: Flex gap-3 (icon + message + dismiss)
- Animation: Slide-in from right, auto-dismiss 5s

**Activity Feed (URL History):**
- List container: space-y-2
- Item: p-3 rounded-md border-l-4
- Layout: Flex justify-between items-start
- Left: URL (text-sm font-mono) + timestamp (text-xs)
- Right: Favicon 16x16
- Max items: 20, scroll if needed

---

## Accessibility & Interaction

**Focus States:**
- Visible focus rings: ring-2 ring-offset-2 rounded
- Keyboard navigation: Logical tab order
- Skip links: For dashboard navigation

**Loading States:**
- Skeleton screens: Animated pulse for student tiles
- Spinners: 24x24 for buttons, 48x48 for page loads
- Progress bars: h-1 rounded-full for uploads

**Empty States:**
- Centered: py-12 text-center
- Icon: 64x64 grayscale
- Heading: text-lg font-medium
- Message: text-sm max-w-md mx-auto
- Action: Primary button mt-6

**Responsive Breakpoints:**
- Mobile: Full-width tiles, stacked navigation
- Tablet (md:): 2-column tiles, horizontal nav
- Desktop (lg:): 3-4 column tiles, sidebar option for filters
- Large (xl:): 4 columns, expanded detail drawer

---

## Icons

**Icon Library:** Heroicons (outline and solid variants via CDN)

**Icon Usage:**
- Navigation: 20x20 outline
- Status indicators: 16x16 solid
- Action buttons: 20x20 outline
- Empty states: 64x64 outline
- Inline with text: 16x16 matching line-height

**Key Icons:**
- Monitor (screen sharing)
- Users (students/roster)
- Clock (last seen)
- Link (URLs)
- Upload (CSV)
- Settings (gear)
- Alert circle (monitoring banner)
- Check circle (online)
- X circle (offline)

---

## Privacy & Transparency Design

**Disclosure Messaging:**
- Always visible in extension popup
- Clear, plain language (no jargon)
- Hierarchy: What's monitored > What's NOT > Student rights
- Link to full privacy policy

**Consent Flows:**
- Share button: Explicit action required
- Confirmation dialog: Before first share
- Persistent indicator: While sharing active
- Easy opt-out: Prominent stop button

**Trust Indicators:**
- Timestamp displays: Show exact last update time
- Connection status: Always visible
- Data retention notice: In settings footer
- Audit log access: For compliance