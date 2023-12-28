"use server";

import { withdrawDao } from "@/lib/cobuild/publishers";
import { useConfig } from "@/lib/config";

export default async function withdraw(from, cell, config) {
  config = config ?? useConfig();

  try {
    const buildingPacket = await withdrawDao(config)({ from, cell });
    return {
      buildingPacket,
    };
  } catch (err) {
    return {
      error: err.toString(),
    };
  }
}