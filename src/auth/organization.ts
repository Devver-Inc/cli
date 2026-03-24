import { Storage } from "../storage";

const CURRENT_ORG_KEY = "auth/currentOrganization";

export async function getCurrentOrganization(): Promise<string | null> {
  try {
    const exists = await Storage.fileExists(CURRENT_ORG_KEY);
    if (!exists) {
      return null;
    }
    return await Storage.readToString(CURRENT_ORG_KEY);
  } catch {
    return null;
  }
}

export async function setCurrentOrganization(orgId: string): Promise<void> {
  await Storage.write(CURRENT_ORG_KEY, orgId);
}

export async function clearCurrentOrganization(): Promise<void> {
  try {
    await Storage.deleteFile(CURRENT_ORG_KEY);
  } catch {}
}
