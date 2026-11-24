import { createScope, defineService } from "../../shared/scope.js";
import { artifactSettlement } from "../runs/index.js";
import type { Database } from "../../../database/index.js";
import { artifactRepository } from "./artifact.repository.js";
import { ArtifactService } from "./artifact.service.js";
import { artifactRoutes } from "./artifact.routes.js";
import type { ArtifactObjectStorage } from "./object-storage.js";

export type { ArtifactObjectStorage } from "./object-storage.js";
export { createMinioArtifactStorage, disabledArtifactStorage, artifactObjectKey, MAX_ARTIFACT_BYTES } from "./object-storage.js";
export type { PublishRequest, PublishResult } from "./artifact.service.js";
export { ArtifactService };
export { createArtifactRepository } from "./artifact.repository.js";
export { artifactCleanup, createArtifactCleanup, type ArtifactCleanup } from "./artifact.cleanup.js";

export function createArtifactService(db: Database, storage: ArtifactObjectStorage) {
  return createScope(db).get(
    defineService(
      { artifacts: artifactRepository, settlement: artifactSettlement },
      ({ artifacts, settlement, transaction }) => new ArtifactService(artifacts, settlement, storage, transaction),
    ),
  );
}

export async function artifactsModule(app: Parameters<typeof artifactRoutes>[0], service: ArtifactService): Promise<void> {
  await artifactRoutes(app, service);
}
