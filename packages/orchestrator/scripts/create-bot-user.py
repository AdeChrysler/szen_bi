#!/usr/bin/env python3
"""
Create (or update) the ZenithSpace Agent bot user in Plane.

This script is designed to run inside the Plane Django container in one of
two ways:

    # Option 1 -- pipe into the Django shell
    docker exec -i plane-api python manage.py shell < create-bot-user.py

    # Option 2 -- run as a standalone script (sets up Django itself)
    docker exec -i plane-api python /path/to/create-bot-user.py

The script is fully idempotent: running it multiple times will not create
duplicate users, memberships, or tokens.  On repeat runs it prints the
existing API token.
"""

from __future__ import annotations

import os
import sys
import traceback

# ---------------------------------------------------------------------------
# Django bootstrap -- only needed when the script is executed directly
# (i.e. NOT piped through ``manage.py shell`` which sets this up for us).
# ---------------------------------------------------------------------------
if not os.environ.get("DJANGO_SETTINGS_MODULE"):
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "plane.settings.production")

    try:
        import django
        django.setup()
    except Exception:
        print(
            "ERROR: Could not initialise Django.  Make sure this script is "
            "executed inside the Plane API container where the Django project "
            "is available.",
            file=sys.stderr,
        )
        traceback.print_exc()
        sys.exit(1)

# ---------------------------------------------------------------------------
# Imports -- safe to do after Django has been set up
# ---------------------------------------------------------------------------
from django.db import transaction  # noqa: E402

from plane.db.models import (  # noqa: E402
    APIToken,
    Project,
    ProjectMember,
    User,
    Workspace,
    WorkspaceMember,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BOT_USERNAME = "zenithspace-agent"
BOT_EMAIL = "agent@zenithspace.app"
BOT_DISPLAY_NAME = "ZenithSpace Agent"

# WorkspaceMember / ProjectMember role constants (from ROLE_CHOICES)
ROLE_ADMIN = 20
ROLE_MEMBER = 15
ROLE_GUEST = 5

# The role the bot will receive when added to workspaces and projects.
BOT_ROLE = ROLE_MEMBER


def get_or_create_bot_user() -> tuple[User, bool]:
    """Return the bot ``User``, creating it if it does not exist yet."""

    try:
        user = User.objects.get(email=BOT_EMAIL)
        created = False
        print(f"  Found existing user: {user.username} (id={user.id})")

        # Ensure key fields are up to date even on an existing user.
        changed = False
        if user.username != BOT_USERNAME:
            user.username = BOT_USERNAME
            changed = True
        if user.display_name != BOT_DISPLAY_NAME:
            user.display_name = BOT_DISPLAY_NAME
            changed = True
        if not user.is_bot:
            user.is_bot = True
            changed = True
        if not user.is_active:
            user.is_active = True
            changed = True

        if changed:
            user.save()
            print("  Updated user fields to match expected configuration.")

    except User.DoesNotExist:
        user = User.objects.create(
            username=BOT_USERNAME,
            email=BOT_EMAIL,
            display_name=BOT_DISPLAY_NAME,
            is_bot=True,
            is_active=True,
            # Bots do not need a usable password
            password="!",
        )
        created = True
        print(f"  Created new bot user: {user.username} (id={user.id})")

    return user, created


def ensure_workspace_memberships(user: User) -> list[Workspace]:
    """Add the bot to every workspace as a member (idempotent)."""

    workspaces = list(Workspace.objects.all())
    if not workspaces:
        print("  WARNING: No workspaces found in the database.")
        return []

    for ws in workspaces:
        _member, created = WorkspaceMember.objects.get_or_create(
            workspace=ws,
            member=user,
            defaults={
                "role": BOT_ROLE,
                "is_active": True,
            },
        )
        if created:
            print(f"  + Added to workspace '{ws.name}' (slug={ws.slug})")
        else:
            # Make sure the membership is active
            if not _member.is_active:
                _member.is_active = True
                _member.save(update_fields=["is_active", "updated_at"])
                print(f"  ~ Reactivated membership in workspace '{ws.name}'")
            else:
                print(f"  = Already a member of workspace '{ws.name}'")

    return workspaces


def ensure_project_memberships(user: User, workspaces: list[Workspace]) -> None:
    """Add the bot to every project in the given workspaces (idempotent)."""

    for ws in workspaces:
        projects = Project.objects.filter(workspace=ws)
        if not projects.exists():
            print(f"  (no projects in workspace '{ws.name}')")
            continue

        for project in projects:
            _member, created = ProjectMember.objects.get_or_create(
                project=project,
                member=user,
                defaults={
                    "workspace": ws,
                    "role": BOT_ROLE,
                    "is_active": True,
                },
            )
            if created:
                print(f"  + Added to project '{project.name}' in '{ws.name}'")
            else:
                if not _member.is_active:
                    _member.is_active = True
                    _member.save(update_fields=["is_active", "updated_at"])
                    print(f"  ~ Reactivated membership in project '{project.name}'")
                else:
                    print(f"  = Already a member of project '{project.name}'")


def ensure_api_token(user: User, workspaces: list[Workspace]) -> str:
    """Return an active API token for the bot, creating one if needed.

    Plane's ``APIToken`` model is scoped to a workspace.  We create one
    token per workspace so the bot can authenticate against any of them.
    If a token already exists we just return it.

    Returns the token string of the *first* workspace's token (usually
    there is only one workspace in a self-hosted setup).
    """

    first_token_value: str | None = None

    for ws in workspaces:
        existing = APIToken.objects.filter(
            user=user,
            workspace=ws,
            label=f"zenithspace-agent-{ws.slug}",
        ).first()

        if existing:
            print(f"  = API token already exists for workspace '{ws.name}'")
            if first_token_value is None:
                first_token_value = existing.token
        else:
            token_obj = APIToken.objects.create(
                user=user,
                workspace=ws,
                label=f"zenithspace-agent-{ws.slug}",
                description="Auto-generated token for the ZenithSpace Agent bot.",
                user_type=1,  # 1 = Bot
                is_active=True,
            )
            print(f"  + Created API token for workspace '{ws.name}'")
            if first_token_value is None:
                first_token_value = token_obj.token

    if first_token_value is None:
        # Fallback: create a workspace-less token (shouldn't normally happen)
        fallback = APIToken.objects.filter(user=user, label="zenithspace-agent").first()
        if fallback:
            first_token_value = fallback.token
        else:
            fallback = APIToken.objects.create(
                user=user,
                label="zenithspace-agent",
                description="Auto-generated token for the ZenithSpace Agent bot (no workspace).",
                user_type=1,
                is_active=True,
            )
            first_token_value = fallback.token
            print("  + Created fallback API token (no workspace)")

    return first_token_value


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    print()
    print("=" * 60)
    print("  ZenithSpace Agent -- Bot User Provisioning")
    print("=" * 60)

    try:
        with transaction.atomic():
            # 1. User
            print()
            print("[1/4] Bot user")
            user, _created = get_or_create_bot_user()

            # 2. Workspace memberships
            print()
            print("[2/4] Workspace memberships")
            workspaces = ensure_workspace_memberships(user)

            # 3. Project memberships
            print()
            print("[3/4] Project memberships")
            ensure_project_memberships(user, workspaces)

            # 4. API token
            print()
            print("[4/4] API token")
            token = ensure_api_token(user, workspaces)

        # -- Summary (outside the transaction so it always prints) ----------
        print()
        print("=" * 60)
        print("  Provisioning complete!")
        print()
        print(f"  Bot user id : {user.id}")
        print(f"  Bot email   : {user.email}")
        print(f"  API token   : {token}")
        print()
        print("  Set this token in your orchestrator environment:")
        print(f"    PLANE_API_TOKEN={token}")
        print("=" * 60)
        print()

    except Exception:
        print()
        print("ERROR: Provisioning failed.  Details below.", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


main()
