"use client";

import Link from "next/link";
import type { Route } from "next";
import { Avatar, Badge, Block, Btn, Icon, PageHead, TileGrid } from "@/components/ui";
import { SecurityRow } from "@/components/domain/SecurityRow";
import { ProjectCard } from "@/components/domain/ProjectCard";
import { ConnectedOAuthAccounts } from "@/components/domain/ConnectedOAuthAccounts";
import { useProjects } from "@/hooks/queries/projects";
import { useProfile } from "@/hooks/queries/account";

export interface ProfileClientProps {
  name: string;
  email: string;
  isSuperAdmin: boolean;
}

export function ProfileClient({ name, email, isSuperAdmin }: ProfileClientProps) {
  const { data: projects } = useProjects();
  const { data: profile } = useProfile();
  const displayName = profile
    ? `${profile.firstName} ${profile.lastName}`.trim()
    : name;

  return (
    <div className="col gap-5">
      <PageHead
        title="Profile"
        sub="Your personal account details and security."
        actions={
          <Link href={"/account/edit-profile" as Route} className="btn outline">
            <Icon name="edit" size={16} />
            Edit profile
          </Link>
        }
      />

      <Block>
        <div className="dda-profile-card">
          <div style={{ position: "relative" }}>
            <Avatar name={displayName} size={84} />
            <button className="btn primary dda-profile-avatar-edit" aria-label="Change avatar">
              <Icon name="edit" size={13} />
            </button>
          </div>
          <div className="col grow" style={{ lineHeight: 1.4, minWidth: 0 }}>
            <span className="row gap-2" style={{ fontSize: 20, fontWeight: 800 }}>
              {displayName}
              {isSuperAdmin && <Badge tone="accent">Super admin</Badge>}
            </span>
            <span className="muted">{profile?.email ?? email}</span>
            <span className="faint" style={{ fontSize: 12.5 }}>
              {profile?.jobTitle ?? "—"} · Member since Jan 2025
            </span>
          </div>
        </div>
      </Block>

      <Block>
        <Block.Header>
          <Block.Title>My projects</Block.Title>
          <Block.Actions>
            <Link href={"/u/projects" as Route} className="btn ghost sm">
              All projects →
            </Link>
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          {projects ? (
            <TileGrid minTile={240}>
              {projects.slice(0, 4).map((p) => (
                <ProjectCard key={p.id} project={p} variant="tile" />
              ))}
            </TileGrid>
          ) : (
            <Block.Loading />
          )}
        </Block.Body>
      </Block>

      <ConnectedOAuthAccounts />

      <Block>
        <Block.Header>
          <Block.Title>Security</Block.Title>
        </Block.Header>
        <div className="col">
          <SecurityRow
            icon="lock"
            title="Password"
            description="Last changed 3 months ago"
            action={
              <Link href={"/account/change-password" as Route} className="btn outline sm">
                Change
              </Link>
            }
          />
          <SecurityRow
            icon="shield"
            title="Two-factor authentication"
            description="Enabled via authenticator app"
            action={
              <Link href={"/account/2fa-manage" as Route} className="btn outline sm">
                Manage
              </Link>
            }
          />
          <SecurityRow
            icon="key"
            title="Active sessions"
            description="2 devices signed in"
            action={
              <Btn variant="outline" size="sm" disabled title="Coming in Phase 10">
                Review
              </Btn>
            }
          />
        </div>
      </Block>
    </div>
  );
}
