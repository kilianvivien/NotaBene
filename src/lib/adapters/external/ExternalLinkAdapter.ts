export interface ExternalLinkAdapter {
  open(url: string): Promise<void>;
}
