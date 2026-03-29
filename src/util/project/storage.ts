import { Storage } from "../../storage";

const CURRENT_PROJECT_KEY = "project/current";

export async function getCurrentProjectId(): Promise<string | null> {
  try {
    const exists = await Storage.fileExists(CURRENT_PROJECT_KEY);
    if (!exists) {
      return null;
    }
    return await Storage.readToString(CURRENT_PROJECT_KEY);
  } catch {
    return null;
  }
}

export async function setCurrentProjectId(projectId: string): Promise<void> {
  await Storage.write(CURRENT_PROJECT_KEY, projectId);
}

export async function clearCurrentProject(): Promise<void> {
  try {
    await Storage.deleteFile(CURRENT_PROJECT_KEY);
  } catch {
    // Ignore if file doesn't exist
  }
}
