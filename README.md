# Polymarket Scanner — Real-Time New Market Monitor

A real-time dashboard that streams newly created Polymarket prediction markets via WebSocket. Designed for detecting mispriced opportunities at market creation time.

## Features

- **Real-time WebSocket streaming** — connects directly to Polymarket's public Market Channel WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`)
- **Persistent storage** — markets are saved to a SQLite backend so you don't lose data on refresh
- **Live feed panel** — terminal-style event log showing connection events, keepalive pings, and new market arrivals
- **Search & filter** — filter across market questions, slugs, and IDs
- **Expandable rows** — click any market to see full description, contract address, and copyable asset IDs
- **Export CSV** — download all tracked markets as CSV for further analysis
- **Sound notifications** — audio ping when new markets arrive (toggleable)
- **Auto-reconnect** — exponential backoff (1s → 30s) on WebSocket disconnection
- **Dark/Light mode** — finance-grade dark theme as default
- **Mobile responsive** — card-based layout on mobile, collapsible sidebar

## Architecture

```
┌─────────────────────────────────────────────────┐
│                    Browser                       │
│                                                  │
│  ┌──────────┐    ┌────────────┐   ┌──────────┐  │
│  │ WebSocket │───>│  app.js    │──>│  DOM UI  │  │
│  │ Client    │    │ (state mgr)│   │ (table,  │  │
│  └──────────┘    └────────────┘   │  feed,   │  │
│       │               │           │  KPIs)   │  │
│       │               │           └──────────┘  │
│       │          ┌────v─────┐                    │
│       │          │ CGI API  │                    │
│       │          │ (SQLite) │                    │
│       │          └──────────┘                    │
│       │                                          │
│  Polymarket WS                                   │
│  (public, no auth)                               │
└─────────────────────────────────────────────────┘
```

### Files

| File | Purpose |
|------|---------|
| `index.html` | Dashboard layout — header, KPI cards, markets table, live feed sidebar |
| `base.css` | Foundation resets, accessibility, reduced-motion support |
| `style.css` | Design tokens, dark/light themes, all component styles |
| `app.js` | WebSocket client, backend API, table rendering, CSV export, sound |
| `cgi-bin/api.py` | SQLite-backed REST API (GET/POST/DELETE) for persistent market storage |

### WebSocket Connection

- **Endpoint**: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- **Auth**: None (public)
- **Subscription**: `{ "assets_ids": [], "type": "market", "custom_feature_enabled": true }`
- **Keepalive**: `{}` every 15 seconds
- **Events**: Listens for `event_type: "new_market"`

### Backend API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/cgi-bin/api.py` | List all markets (supports `?limit=N` and `?since=TIMESTAMP`) |
| POST | `/cgi-bin/api.py` | Save a new market (JSON body) |
| DELETE | `/cgi-bin/api.py?id=ID` | Delete a market by ID |

## Roadmap

- [ ] Agent-based analysis of newly created markets
- [ ] Price deviation detection at market creation
- [ ] Automated trade placement via Polymarket CLOB API
- [ ] Historical mispricing pattern analysis

## References

- [Polymarket Market Channel WebSocket Docs](https://docs.polymarket.com/market-data/websocket/market-channel)
- [Polymarket WebSocket Overview](https://docs.polymarket.com/market-data/websocket/overview)
- [Polymarket Trading SDK](https://docs.polymarket.com/)
