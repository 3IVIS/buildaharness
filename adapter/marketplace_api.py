"""
Component marketplace — community node registry.

Public discovery (no auth):
  GET  /marketplace              → paginated list; supports ?q=, ?category=, ?verified=
  GET  /marketplace/{slug}       → full component detail

Authenticated:
  POST /marketplace              → publish a new component
  POST /marketplace/{slug}/install → record install, return node_spec + tool_def

Startup:
  seed_marketplace()             → called from lifespan; idempotently inserts the
                                   six built-in @itsharness components on first boot.

The install endpoint does not modify any flow — it returns the node_spec and
tool_def fragments that the frontend drops onto the canvas and registers in the
flow's tools registry.  Keeping the operation stateless on the backend means
multiple users can install the same component into different flows without any
server-side flow mutation.
"""

import os
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from auth import current_user
from db import CommunityComponent, User, get_session
from rate_limit import limiter

router = APIRouter(prefix="/marketplace", tags=["marketplace"])

# ── Seed data ─────────────────────────────────────────────────────────────────
# Six canonical @itsharness components covering the most common tool gaps.
# Each entry mirrors the CommunityComponent columns.  slug is the primary key.

_SEED_COMPONENTS: list[dict[str, Any]] = [
    {
        "slug": "web-search",
        "name": "Web Search",
        "description": "Search the web with Tavily and return top results as structured text.",
        "category": "tool",
        "icon_emoji": "🔍",
        "npm_ref": "@langchain/community/tools/TavilySearchResults",
        "source": "npm",
        "verified": "true",
        "author": "@itsharness",
        "tags": ["search", "web", "tavily", "retrieval"],
        "node_spec": {
            "type": "tool_invoke",
            "tool_id": "web_search",
            "data": {"label": "Web Search"},
        },
        "tool_def": {
            "tool_ref": "@langchain/community/tools/TavilySearchResults",
            "source": "npm",
            "description": "Search the web with Tavily and return top results",
            "input_schema": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "Search query"}},
                "required": ["query"],
            },
        },
    },
    {
        "slug": "pdf-reader",
        "name": "PDF Reader",
        "description": "Load and extract text from a PDF file or URL using PyMuPDF.",
        "category": "tool",
        "icon_emoji": "📄",
        "npm_ref": "@itsharness/tool-pdf-reader",
        "source": "npm",
        "verified": "true",
        "author": "@itsharness",
        "tags": ["pdf", "document", "extraction", "file"],
        "node_spec": {
            "type": "tool_invoke",
            "tool_id": "pdf_reader",
            "data": {"label": "PDF Reader"},
        },
        "tool_def": {
            "tool_ref": "@itsharness/tool-pdf-reader",
            "source": "npm",
            "description": "Load and extract text from a PDF file or URL",
            "input_schema": {
                "type": "object",
                "properties": {"source": {"type": "string", "description": "File path or URL to the PDF"}},
                "required": ["source"],
            },
        },
    },
    {
        "slug": "slack-notifier",
        "name": "Slack Notifier",
        "description": "Post a message to a Slack channel via the Slack Web API.",
        "category": "tool",
        "icon_emoji": "💬",
        "npm_ref": "@langchain/community/tools/SlackTool",
        "source": "npm",
        "verified": "true",
        "author": "@itsharness",
        "tags": ["slack", "notification", "messaging", "webhook"],
        "node_spec": {
            "type": "tool_invoke",
            "tool_id": "slack_notifier",
            "data": {"label": "Slack Notifier"},
        },
        "tool_def": {
            "tool_ref": "@langchain/community/tools/SlackTool",
            "source": "npm",
            "description": "Post a message to a Slack channel",
            "input_schema": {
                "type": "object",
                "properties": {
                    "channel": {"type": "string", "description": "Channel name or ID"},
                    "message": {"type": "string", "description": "Message text to post"},
                },
                "required": ["channel", "message"],
            },
        },
    },
    {
        "slug": "github-issues",
        "name": "GitHub Issues",
        "description": "Create, list, or comment on GitHub issues via the REST API.",
        "category": "tool",
        "icon_emoji": "🐙",
        "npm_ref": "@langchain/community/tools/GitHubToolkit",
        "source": "npm",
        "verified": "true",
        "author": "@itsharness",
        "tags": ["github", "issues", "devtools", "api"],
        "node_spec": {
            "type": "tool_invoke",
            "tool_id": "github_issues",
            "data": {"label": "GitHub Issues"},
        },
        "tool_def": {
            "tool_ref": "@langchain/community/tools/GitHubToolkit",
            "source": "npm",
            "description": "Interact with GitHub issues on a repository",
            "input_schema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["create", "list", "comment"]},
                    "repo": {"type": "string", "description": "owner/repo"},
                    "title": {"type": "string", "description": "Issue title (create only)"},
                    "body": {"type": "string", "description": "Issue body or comment"},
                },
                "required": ["action", "repo"],
            },
        },
    },
    {
        "slug": "sql-query",
        "name": "SQL Query",
        "description": "Run read-only SQL queries against a Postgres or SQLite database.",
        "category": "tool",
        "icon_emoji": "🗄️",
        "npm_ref": "@langchain/community/tools/SqlTool",
        "source": "npm",
        "verified": "true",
        "author": "@itsharness",
        "tags": ["sql", "database", "postgres", "sqlite", "query"],
        "node_spec": {
            "type": "tool_invoke",
            "tool_id": "sql_query",
            "data": {"label": "SQL Query"},
        },
        "tool_def": {
            "tool_ref": "@langchain/community/tools/SqlTool",
            "source": "npm",
            "description": "Run a read-only SQL query and return the result as JSON",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "SQL SELECT statement"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "slug": "http-request",
        "name": "HTTP Request",
        "description": "Make an authenticated HTTP request and return the JSON response body.",
        "category": "tool",
        "icon_emoji": "🌐",
        "npm_ref": "@itsharness/tool-http-request",
        "source": "npm",
        "verified": "true",
        "author": "@itsharness",
        "tags": ["http", "api", "rest", "fetch", "request"],
        "node_spec": {
            "type": "tool_invoke",
            "tool_id": "http_request",
            "data": {"label": "HTTP Request"},
        },
        "tool_def": {
            "tool_ref": "@itsharness/tool-http-request",
            "source": "npm",
            "description": "Make an HTTP request and return the response body",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to request"},
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "default": "GET"},
                    "headers": {"type": "object", "description": "HTTP headers dict"},
                    "body": {"type": "object", "description": "Request body (POST/PUT/PATCH)"},
                },
                "required": ["url"],
            },
        },
    },
]

# ── Pydantic schemas ──────────────────────────────────────────────────────────


class ComponentSummary(BaseModel):
    slug: str
    name: str
    description: str
    category: str
    icon_emoji: str
    npm_ref: str
    source: str
    tags: list[str]
    verified: bool
    author: str
    install_count: int


class ComponentDetail(ComponentSummary):
    node_spec: dict
    tool_def: dict | None
    created_at: datetime
    updated_at: datetime


class PublishRequest(BaseModel):
    slug: str = Field(..., min_length=2, max_length=80, pattern=r"^[a-z0-9][a-z0-9\-]*[a-z0-9]$")
    name: str = Field(..., min_length=1, max_length=100)
    description: str = Field(..., min_length=1, max_length=400)
    category: str = Field(..., pattern=r"^(tool|memory|agent|control)$")
    icon_emoji: str = Field(default="🔧", max_length=8)
    npm_ref: str = Field(..., min_length=1, max_length=200)
    source: str = Field(default="npm", pattern=r"^(npm|mcp|local)$")
    node_spec: dict = {}
    tool_def: dict | None = None
    tags: list[str] = Field(default=[], max_length=20)


class InstallResponse(BaseModel):
    slug: str
    name: str
    node_spec: dict
    tool_def: dict | None
    tool_id: str  # suggested key for the tools registry


# ── Helpers ───────────────────────────────────────────────────────────────────


def _to_summary(row: CommunityComponent) -> ComponentSummary:
    return ComponentSummary(
        slug=row.slug,
        name=row.name,
        description=row.description,
        category=row.category,
        icon_emoji=row.icon_emoji,
        npm_ref=row.npm_ref,
        source=row.source,
        tags=list(row.tags or []),
        verified=row.verified == "true",
        author=row.author,
        install_count=row.install_count,
    )


def _to_detail(row: CommunityComponent) -> ComponentDetail:
    return ComponentDetail(
        **_to_summary(row).model_dump(),
        node_spec=dict(row.node_spec or {}),
        tool_def=dict(row.tool_def) if row.tool_def else None,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("", response_model=list[ComponentSummary])
@limiter.limit("60/minute")
async def list_components(
    request: Request,
    q: str | None = Query(default=None, description="Full-text search on name, description, tags"),
    category: str | None = Query(default=None, description="Filter by category: tool|memory|agent|control"),
    verified: bool | None = Query(default=None, description="Filter to verified-only components"),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_session),
) -> list[ComponentSummary]:
    """List community components.

    No authentication required — the marketplace is publicly browsable.
    Supports free-text search across name, description, and tags, plus
    category and verified filters.  Results are ordered verified-first,
    then by install_count descending so popular components surface first.
    """
    stmt = select(CommunityComponent)

    if q:
        term = f"%{q.lower()}%"
        from sqlalchemy import String, cast

        stmt = stmt.where(
            func.lower(CommunityComponent.name).like(term)
            | func.lower(CommunityComponent.description).like(term)
            | func.lower(cast(CommunityComponent.tags, String)).like(term)
        )

    if category:
        stmt = stmt.where(CommunityComponent.category == category)

    if verified is not None:
        stmt = stmt.where(CommunityComponent.verified == ("true" if verified else "false"))

    stmt = (
        stmt.order_by(CommunityComponent.verified.desc(), CommunityComponent.install_count.desc())
        .limit(limit)
        .offset(offset)
    )

    rows = (await db.execute(stmt)).scalars().all()
    return [_to_summary(r) for r in rows]


@router.get("/{slug}", response_model=ComponentDetail)
@limiter.limit("60/minute")
async def get_component(
    request: Request,
    slug: str,
    db: AsyncSession = Depends(get_session),
) -> ComponentDetail:
    """Return full detail for a single component, including node_spec and tool_def."""
    row = (await db.execute(select(CommunityComponent).where(CommunityComponent.slug == slug))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail=f"Component '{slug}' not found.")
    return _to_detail(row)


@router.post("", response_model=ComponentDetail, status_code=201)
@limiter.limit("10/minute")
async def publish_component(
    request: Request,
    req: PublishRequest,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_session),
) -> ComponentDetail:
    """Publish a new community component.

    Requires authentication.  The slug must be globally unique.
    Published components are NOT verified by default — only @itsharness seed
    components carry verified=true.  A future admin endpoint can promote them.
    """
    existing = (
        await db.execute(select(CommunityComponent).where(CommunityComponent.slug == req.slug))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"A component with slug '{req.slug}' already exists.",
        )

    now = datetime.now(UTC)
    row = CommunityComponent(
        id=uuid.uuid4(),
        slug=req.slug,
        name=req.name,
        description=req.description,
        category=req.category,
        icon_emoji=req.icon_emoji,
        npm_ref=req.npm_ref,
        source=req.source,
        node_spec=req.node_spec,
        tool_def=req.tool_def,
        tags=req.tags,
        verified="false",  # user-published components start unverified
        author=f"user:{user.id}",
        install_count=0,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    return _to_detail(row)


@router.post("/{slug}/install", response_model=InstallResponse)
@limiter.limit("30/minute")
async def install_component(
    request: Request,
    slug: str,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_session),
) -> InstallResponse:
    """Record an install and return the node_spec + tool_def for canvas drop.

    The frontend:
      1. Calls this endpoint to get the node_spec and tool_def.
      2. Adds the node_spec fragment as a new node on the canvas at the drop
         position (same as dragging from the built-in palette).
      3. Auto-registers the tool_def under tool_id in the flow's tools registry
         so tool_invoke nodes can reference it by tool_id.

    Incrementing install_count is best-effort — a failure there never blocks
    the install response so the user always gets their node.
    """
    row = (await db.execute(select(CommunityComponent).where(CommunityComponent.slug == slug))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail=f"Component '{slug}' not found.")

    # Best-effort increment — if this races or fails, the install still succeeds.
    try:
        await db.execute(
            update(CommunityComponent)
            .where(CommunityComponent.slug == slug)
            .values(install_count=CommunityComponent.install_count + 1)
        )
        await db.commit()
    except Exception:
        await db.rollback()

    # tool_id is the slug with hyphens replaced by underscores — matches the
    # tool_def key convention used across the reference flows.
    tool_id = slug.replace("-", "_")

    return InstallResponse(
        slug=row.slug,
        name=row.name,
        node_spec=dict(row.node_spec or {}),
        tool_def=dict(row.tool_def) if row.tool_def else None,
        tool_id=tool_id,
    )


# ── Startup seeder ────────────────────────────────────────────────────────────


async def seed_marketplace() -> None:
    """Idempotently insert the six built-in @itsharness components at startup.

    Skips rows whose slug already exists so re-deploys are safe.
    Always runs (unlike eval seeder it needs no Langfuse) — the marketplace
    table must be populated even on fresh installs with no external deps.
    No-op when TESTING=true to keep test runs fast.
    """
    if os.getenv("TESTING") == "true":
        return

    from db import SessionLocal  # import here to avoid circular at module load

    now = datetime.now(UTC)
    async with SessionLocal() as db:
        for entry in _SEED_COMPONENTS:
            existing = (
                await db.execute(select(CommunityComponent).where(CommunityComponent.slug == entry["slug"]))
            ).scalar_one_or_none()

            if existing:
                continue  # idempotent — slug already present

            row = CommunityComponent(
                id=uuid.uuid4(),
                slug=entry["slug"],
                name=entry["name"],
                description=entry["description"],
                category=entry["category"],
                icon_emoji=entry["icon_emoji"],
                npm_ref=entry["npm_ref"],
                source=entry["source"],
                node_spec=entry["node_spec"],
                tool_def=entry.get("tool_def"),
                tags=entry.get("tags", []),
                verified=entry["verified"],
                author=entry["author"],
                install_count=0,
                created_at=now,
                updated_at=now,
            )
            db.add(row)
            print(f"[itsharness] marketplace: seeded '{entry['slug']}'", flush=True)

        await db.commit()
