export interface ArtifactRef {
  readonly id: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly uri: string;
  readonly version?: string;
}
export interface ArtifactWriter {
  write(value: string, options: { namespace: string; mediaType: string; signal: AbortSignal }): Promise<ArtifactRef>;
}
