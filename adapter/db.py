"""
Database models and async engine — SQLAlchemy 2 + asyncpg.
Tables: users, flows, flow_versions
"""
import os
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Text, Integer, DateTime, ForeignKey,
    UniqueConstraint, func, select,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, relationship

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://itsharness:itsharness@postgres:5432/itsharness",
)

engine       = create_async_engine(DATABASE_URL, echo=False)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email         = Column(Text, unique=True, nullable=False)
    password_hash = Column(Text, nullable=False)
    created_at    = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    flows    = relationship("Flow",        back_populates="user", cascade="all, delete-orphan")
    versions = relationship("FlowVersion", back_populates="user")


class Flow(Base):
    __tablename__ = "flows"

    id           = Column(Text, primary_key=True)   # matches FlowSpec.id
    user_id      = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name         = Column(Text, nullable=False)
    current_spec = Column(JSONB, nullable=False)
    created_at   = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at   = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    user     = relationship("User",        back_populates="flows")
    versions = relationship("FlowVersion", back_populates="flow",
                            cascade="all, delete-orphan",
                            order_by="FlowVersion.version_num")


class FlowVersion(Base):
    __tablename__  = "flow_versions"
    __table_args__ = (UniqueConstraint("flow_id", "version_num"),)

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    flow_id     = Column(Text, ForeignKey("flows.id", ondelete="CASCADE"), nullable=False)
    user_id     = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    spec        = Column(JSONB, nullable=False)
    version_num = Column(Integer, nullable=False)
    label       = Column(Text, nullable=True)
    created_at  = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    flow = relationship("Flow", back_populates="versions")
    user = relationship("User", back_populates="versions")


async def get_session():
    async with SessionLocal() as session:
        yield session


async def next_version_num(flow_id: str, db: AsyncSession) -> int:
    result = await db.execute(
        select(func.max(FlowVersion.version_num)).where(FlowVersion.flow_id == flow_id)
    )
    current_max = result.scalar_one_or_none()
    return (current_max or 0) + 1


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("[db] tables ready")
