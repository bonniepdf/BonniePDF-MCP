export interface ExampleEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  tier: string;
  capabilities: string[];
  industries: string[];
  documentType?: string;
  source: { typescript?: string; dotnet?: string };
  definition?: string;
  notes: unknown[];
  unavailable?: string;
  verification?: { strict: boolean; pdf: boolean; svg: boolean; canonicalRoundTrip: boolean };
}
export interface DocEntry {
  id: string;
  title: string;
  language: string;
  url: string;
  text: string;
}
export interface Knowledge {
  format: number;
  coreVersion: string;
  definitionVersion: string;
  hash: string;
  exampleClock: string;
  examples: ExampleEntry[];
  docs: DocEntry[];
}
