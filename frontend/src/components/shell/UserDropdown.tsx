"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Avatar, Icon, Menu, MenuItem, MenuSeparator } from "@/components/ui";

export interface UserDropdownProps {
  name: string;
  email: string;
}

export function UserDropdown({ name, email }: UserDropdownProps) {
  const router = useRouter();
  const firstName = name.split(" ")[0] ?? name;

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    router.push("/auth/login");
    router.refresh();
  }

  return (
    <Menu
      width={252}
      align="end"
      trigger={
        <button className="dda-user-pill row gap-2" aria-label="Account menu">
          <Avatar name={name} size={28} />
          <span style={{ fontSize: 12.5, fontWeight: 700 }} className="hide-sm">
            {firstName}
          </span>
          <Icon name="chevD" size={14} style={{ color: "var(--text-faint)" }} />
        </button>
      }
    >
      <div className="row gap-3" style={{ padding: "8px 10px 10px" }}>
        <Avatar name={name} size={38} />
        <div className="col" style={{ lineHeight: 1.3, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{name}</span>
          <span className="faint" style={{ fontSize: 11.5 }}>{email}</span>
        </div>
      </div>
      <MenuSeparator />
      <MenuItem icon="user">
        <Link href={"/account/profile" as Route} style={{ color: "inherit" }}>Profile</Link>
      </MenuItem>
      <MenuItem icon="edit">
        <Link href={"/account/edit-profile" as Route} style={{ color: "inherit" }}>Edit profile</Link>
      </MenuItem>
      <MenuItem icon="lock">
        <Link href={"/account/change-password" as Route} style={{ color: "inherit" }}>Change password</Link>
      </MenuItem>
      <MenuItem icon="shield">
        <Link href={"/account/2fa-manage" as Route} style={{ color: "inherit" }}>Two-factor authentication</Link>
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="logout" danger onSelect={() => void logout()}>
        Log out
      </MenuItem>
    </Menu>
  );
}
