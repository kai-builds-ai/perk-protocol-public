"use client";

import React from "react";
import { TopBar } from "@/components/TopBar";
import { CreateMarketForm } from "@/components/CreateMarketForm";

export default function LaunchPage() {
  return (
    <div className="flex flex-col h-screen">
      <TopBar />
      <div className="flex-1 overflow-auto pb-8">
        <CreateMarketForm />
      </div>
    </div>
  );
}
