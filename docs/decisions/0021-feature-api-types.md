# 0021. Feature API message types live in contracts

- Status: accepted
- Date: 2026-10-02

## Context and problem

TypeScript types are generated from `contracts` only (0003). Features have their own API
messages (search hits, backlinks).

## Decision

Their types (`SearchHit`, `Backlink`, `Unresolved`, …) are defined in `contracts::api`,
like every other API message, and generated with the rest. Method names stay in the features
(`search.query`, `links.backlinks`), so the kernel ring still names no feature in a string.

## Consequences

A feature's API shape changes in contracts, where every crate can see it.
