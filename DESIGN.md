# Perk (perk.fund) — Design System

> If it feels slow, it's broken. If it looks like every other DeFi app, we failed.

---

## Core Philosophy

This is a **trading terminal**, not a marketing site. Traders don't browse — they execute. Every pixel either helps them make a decision or it's in the way.

**Three pillars:**
1. **Speed** — sub-second everything. No spinners, no skeleton loaders, no "loading...". Optimistic UI. Stale data with live indicators.
2. **Density** — show everything at once. Traders want 12 numbers visible, not hidden behind 3 tabs.
3. **Clarity** — color means something. Position means something. Nothing decorative.

---

## Speed Rules (Non-Negotiable)

These aren't nice-to-haves. If we violate any of these, we fix it before shipping.

### Data
- **WebSocket for all live data.** Never poll for price, position PnL, or order book state.
- **Pyth price stream** via Hermes WebSocket — sub-100ms price updates.
- **Solana account subscriptions** (`onAccountChange`) for position and market state — instant updates when on-chain state changes.
- **No REST calls in the hot path.** REST for initial load only. After that, everything streams.

### Rendering
- **No full-page re-renders.** Use React memoization aggressively. Price ticking should not re-render the trade panel.
- **Isolate fast-updating components.** Price display, PnL, chart — each in their own render boundary.
- **Number formatting is cached.** Don't call `toLocaleString()` on every frame.
- **No CSS-in-JS runtime.** Tailwind only. Zero runtime style computation.

### Transactions
- **Optimistic UI for every action.** Click "Open Long" → UI shows position immediately, confirms/reverts on chain confirmation.
- **Pre-compute transactions.** When user is filling in the trade form, build the transaction in the background. On click, it's ready to sign.
- **Batch where possible.** Deposit + open position in one transaction if the user has no existing deposit.
- **Priority fees.** Auto-calculate and include Solana priority fees. No "transaction failed" because of congestion.

### Loading
- **First meaningful paint < 1 second.** SSR the market explorer. Static generation for layout.
- **Chart loads independently.** Don't block page render on TradingView init.
- **Token logos: preload above-the-fold, lazy load the rest.**
- **No loading spinners.** Show stale data with a subtle "connecting..." indicator. Never show a blank screen.

### Perceived Speed
- **Instant tab/page transitions.** Use Next.js App Router parallel routes + prefetching.
- **Hover prefetch.** When user hovers a market row, prefetch that market's data.
- **Debounce inputs, not outputs.** Leverage slider updates the estimate instantly, debounce the API/calculation call.

---

## Anti-AI-Slop Rules

### Typography
- **Monospace for all numbers:** JetBrains Mono (or IBM Plex Mono)
  - Prices, sizes, PnL, percentages, leverage, addresses
  - Numbers must be tabular (fixed-width digits) so columns align
- **Sans-serif for UI text:** Space Grotesk
  - Labels, buttons, headings, descriptions
  - Weight 400 (body), 500 (labels), 600 (headings)
- **Two fonts max.** No third font. No display fonts. No serif.
- **No Inter. No Roboto. No Geist.** These are the AI-slop signature.

### Colors
```
Background:     #09090b (near-black, not pure black)
Surface:        #0f0f11 (panels, cards)
Border:         #1a1a1e (subtle separation)
Text primary:   #fafafa (near-white)
Text secondary: #71717a (muted, zinc-500)
Text tertiary:  #3f3f46 (very muted, zinc-700)

Green (long/profit):    #22c55e (green-500, use sparingly)
Green muted:            #16a34a (green-600, for backgrounds)
Red (short/loss):       #ef4444 (red-500)
Red muted:              #dc2626 (red-600, for backgrounds)
Yellow (warning):       #eab308 (yellow-500)
Blue (info/links):      #3b82f6 (blue-500, minimal use)

Accent:                 #fafafa (white is the accent — used for primary buttons, active states)
```

- **No purple. No gradient. No teal. No brand color for the sake of brand color.**
- **White is the accent.** Primary buttons are white text on white border. Active tabs are white. Everything else is muted.
- **Green and red are ONLY for profit/loss.** Never decorative.

### Layout
- **No hero sections.** The app IS the landing page.
- **No card grids.** Use tables for tabular data. Always.
- **Borders, not shadows.** 1px solid #1a1a1e. No box-shadow. No glow. No glassmorphism.
- **Square corners on panels.** 0px or 2px border-radius max. Buttons get 4px. That's it.
- **No excessive padding.** 12px-16px panel padding. Not 24px-32px. Dense.
- **Fixed layout, not responsive-first.** This is a desktop trading app. Design for 1440px+. Mobile is a later concern.
- **Panels are separated by borders, not whitespace.** Like a Bloomberg terminal — everything edge-to-edge.

### Components

**Buttons:**
```
Primary:   bg-transparent, border-white, text-white, hover:bg-white/10
           (NOT solid white background — too flashy)
Long:      bg-green-500/10, border-green-500/50, text-green-500
Short:     bg-red-500/10, border-red-500/50, text-red-500
Subtle:    bg-transparent, text-zinc-400, hover:text-white
Disabled:  text-zinc-600, border-zinc-800, no hover effect
```

**Inputs:**
```
bg-transparent, border-zinc-800, text-white
focus: border-zinc-500 (subtle brighten, NOT blue glow)
No input labels floating inside the field — label above or to the left
Monospace font for numeric inputs
```

**Tables:**
```
No alternating row colors (too busy)
Row hover: bg-white/[0.02] (barely visible)
Header: text-zinc-500, uppercase, text-xs, tracking-wider
Cells: text-white (primary data), text-zinc-400 (secondary)
Right-align all numbers
No vertical borders — horizontal only, very subtle
```

**Tabs/Toggles:**
```
Active: text-white, border-b-white (2px underline)
Inactive: text-zinc-500, hover:text-zinc-300
No pill/chip style. Underline style only.
```

### Icons
- **Minimal.** Most things don't need an icon.
- **Token logos are the main visual element.** Everything else is text.
- **If an icon is needed:** Lucide icons, 16px, stroke-width 1.5, zinc-500 color.
- **No filled icons. No colored icons. No icon + text where text alone works.**

### Motion
- **No decorative animations.** No entrance animations. No hover transforms. No floating elements.
- **Functional transitions only:**
  - Tab switch: 100ms opacity fade
  - Tooltip: 50ms appear, 100ms disappear
  - Number change: color flash (green/red) for 300ms, then return to white
  - Price tick: brief color pulse, no slide/count-up animation
- **PnL color transitions:** When PnL flips from negative to positive (or vice versa), the color change is instant. No lerp.

### What NOT To Do (AI Slop Checklist)

If any of these appear in a PR, it gets rejected:

- [ ] Gradient backgrounds (linear-gradient, radial-gradient anywhere visible)
- [ ] Purple or teal as primary colors
- [ ] Box shadows on panels
- [ ] Border-radius > 4px on anything that isn't a button or avatar
- [ ] Glassmorphism (backdrop-blur + transparency)
- [ ] Particle effects, floating dots, animated backgrounds
- [ ] "Welcome to Perk" hero section
- [ ] Stock illustrations or abstract art
- [ ] Skeleton loaders (use real data or stale data, never gray shapes)
- [ ] Loading spinners blocking interaction
- [ ] Cards with icons + title + description in a 3-column grid
- [ ] Excessive whitespace between sections (> 16px)
- [ ] Inter or Roboto font
- [ ] Decorative use of green/red (only for profit/loss)
- [ ] "Powered by Solana" or partner logo bars
- [ ] Testimonials or social proof sections
- [ ] FAQ accordions
- [ ] Any element that exists for "polish" but doesn't help trading

---

## Page-Specific Design

### Market Explorer (`/`)

The first thing you see. Not a splash page — it's a data terminal.

```
Top bar: [Perk]  [SOL: $150.32]  [Total Vol: $12M]  [Markets: 47]  [Connect Wallet]

Below, full-width table:

Token        Price        24h Chg    24h Volume    OI          Funding     Leverage   
─────────────────────────────────────────────────────────────────────────────────────
◉ SOL        $150.32      +2.41%     $4,210,000    $1,890,000  +0.003%     20x    →
◉ BONK       $0.00001832  -4.12%     $890,000      $234,000    -0.001%     10x    →
◉ WIF        $1.2341      +0.89%     $670,000      $189,000    +0.002%     15x    →
◉ JUP        $0.8912      +1.23%     $340,000      $78,000     +0.001%     10x    →

◉ = token logo (24px circle)
→ = click row to trade

[+ Create Market] button in top-right, subtle, not screaming
```

- Table is sortable by any column (click header)
- Search/filter bar above table (just a text input, searches token name/symbol)
- No pagination — virtual scroll if > 50 markets
- Row click → navigates to `/trade/[token]`
- Green/red on 24h change only

### Trading View (`/trade/[token]`)

Single-page, no scroll needed at 1080p.

```
┌──────────────────────────────────────────────────────────────┐
│ ◉ SOL-PERP  $150.32  +2.41%  │ Funding: +0.003%/1h         │
│ Mark: $150.32  Index: $150.28 │ OI: $1.89M  Vol: $4.21M     │
├───────────────────────────────┼──────────────────────────────┤
│                               │                              │
│                               │  MARKET    LIMIT    STOP/TP  │
│                               │  ─────────────────           │
│    [TradingView Chart]        │                              │
│    Full indicators,           │  ┌─LONG─┐  ┌─SHORT─┐        │
│    drawing tools,             │                              │
│    multi-timeframe            │  Size     [________] SOL     │
│                               │  Leverage [════════|] 5.0x   │
│                               │  Price    [________] USD     │
│                               │           (limit/stop only)  │
│                               │                              │
│                               │  Entry     $150.32           │
│                               │  Liq       $125.27           │
│                               │  Fee       $0.75             │
│                               │  Slippage  ~0.08%            │
│                               │                              │
│                               │  [ OPEN LONG ──────────── ]  │
│                               │                              │
│                               │  ── BALANCE ──               │
│                               │  Wallet   50.24 SOL          │
│                               │  Vault    20.00 SOL          │
│                               │  [Deposit]  [Withdraw]       │
├───────────────────────────────┴──────────────────────────────┤
│ Positions (1)                                                │
│ ────────────────────────────────────────────────────────     │
│ SOL-PERP  LONG  5x  10 SOL  Entry $148.50  PnL +$18.20     │
│ +1.22%  Liq $125.30  [TP] [SL] [Close]                      │
├──────────────────────────────────────────────────────────────┤
│ Orders (2)                                                   │
│ ────────────────────────────────────────────────────────     │
│ LIMIT LONG   $140.00  5 SOL  5x   GTC              [Cancel] │
│ STOP LOSS    $130.00  close position                [Cancel] │
└──────────────────────────────────────────────────────────────┘
```

Key UX details:
- **Long button is green-tinted, Short is red-tinted.** Selected state is brighter.
- **Leverage slider shows exact value** updating in real-time as you drag. Snaps to 1x, 2x, 3x, 5x, 10x, 15x, 20x.
- **Estimates update instantly** as you type size or drag leverage. No debounce on the display — debounce the calculation if needed but show SOMETHING immediately.
- **PnL in positions flashes green/red** on every price tick. Color pulse, not animation.
- **Close button on position** shows confirmation with PnL preview. One click to confirm.
- **Keyboard shortcuts:** `B` = buy/long, `S` = sell/short, `Esc` = cancel, `Enter` = submit order.

### Create Market (`/launch`)

Feels like a configuration panel, not a signup form.

```
┌──────────────────────────────────────────────────────────────┐
│ CREATE MARKET                                                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Token    [_________________________] 🔍                     │
│           ◉ MYTOKEN (MyToken)  Raydium pool ✓  $1.2M liq   │
│                                                              │
│  Oracle   (●) DEX Pool (Raydium)    ( ) Pyth Price Feed     │
│  Pool     7xK...3nP  $1,234,567 liquidity                   │
│                                                              │
│  ── PARAMETERS ──                                            │
│                                                              │
│  Max Leverage     [════|════════] 10x                        │
│  Trading Fee      [══|══════════] 0.10%                      │
│  Initial Depth    [══════|══════] Medium                     │
│                                                              │
│  ── YOUR REVENUE ──                                          │
│                                                              │
│  You earn 10% of all trading fees on this market.            │
│  At $100K daily volume → $10/day ($300/month)                │
│  At $1M daily volume → $100/day ($3,000/month)               │
│                                                              │
│  Cost: ~0.05 SOL (account rent)                              │
│                                                              │
│  [ CREATE MARKET ]                                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- Token search is instant — searches Jupiter Token List locally
- Shows pool liquidity so creator knows if oracle will be reliable
- Revenue estimate updates as they change the fee slider
- No unnecessary fields. Token, oracle, three sliders, create.

---

## Token Logos

### Resolution Order
1. **Jupiter Token List** — has logos for all verified + popular tokens
2. **Helius DAS API** — token metadata including image URI
3. **On-chain Metaplex metadata** — image field
4. **Generated identicon** — deterministic from mint address, unique colors/shape

### Display
- **24px** in tables (market explorer, positions)
- **32px** in trade panel header
- **16px** inline with text
- **Circle clip** with 1px border matching surface color
- **No placeholder squares.** Always show something — even the identicon looks intentional.

### Identicon Fallback
Generate a unique geometric icon from the first 6 bytes of the mint address:
- 4x4 grid, mirrored horizontally (symmetrical)
- Color derived from address bytes
- Looks like GitHub default avatars — clean, not random

---

## Performance Budgets

| Metric | Target | How |
|---|---|---|
| First Contentful Paint | < 800ms | SSR market explorer, inline critical CSS |
| Time to Interactive | < 1.5s | Code split TradingView chart, lazy load below fold |
| Price update latency | < 100ms | Pyth WebSocket direct, no intermediary |
| Position PnL update | < 200ms | Solana account subscription, client-side calc |
| Trade submission | < 50ms to "pending" | Optimistic UI, pre-built transaction |
| Page navigation | < 100ms perceived | Prefetch on hover, parallel routes |
| JS bundle (main) | < 150KB gzipped | Tree shake everything, dynamic imports |
| JS bundle (chart) | Separate chunk | Loaded after initial render |

---

## Responsive Strategy

**Day 1: Desktop only.** Minimum 1280px width. Below that, show a "desktop recommended" banner but don't break.

**Why:** Trading on mobile is a different product. Cramming a desktop trading terminal into 375px makes everything worse. When we do mobile, it's a purpose-built mobile experience, not a squeezed desktop.

**The top bar collapses gracefully** at smaller widths (hide stats, keep logo + connect button). But the trading view is fixed-width.

---

## Summary

| Principle | Implementation |
|---|---|
| Speed | WebSocket everything, optimistic UI, pre-built txns, no spinners |
| Density | Tables not cards, minimal padding, everything visible at once |
| Clarity | Green/red = profit/loss only, monospace numbers, no decorative color |
| No AI slop | No gradients, no Inter, no shadows, no hero section, no cards |
| Professional | Looks like Bloomberg, not like a hackathon project |
