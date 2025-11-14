export type RelationInfo = {
  calls?: string[];
  calledBy?: string[];
  references?: string[];
};

export type HierarchyInfo = {
  superClass?: string;
  interfaces?: string[];
};

export type SpringInfo = {
  isSpringBean?: boolean;
  beanType?: string;
  beanName?: string;
  autoWiredDependencies?: string[];
  annotations?: string[];
};

export type UploadInfo = {
  schemaVersion?: number;
  projectName?: string;
  generatedAt?: string;
  uploadedAt?: string;
  batchCount?: number;
};

export type SymbolRecord = {
  fqn: string;
  kind: "CLASS" | "INTERFACE" | "METHOD" | "MODULE" | "REPOSITORY";
  module: string;
  modulePath?: string;
  repoName?: string;
  packageName?: string;
  summary: string;
  metadata?: Record<string, unknown>;
  indexLevel?: string;
  relations?: RelationInfo;
  hierarchy?: HierarchyInfo;
  springInfo?: SpringInfo;
  uploadInfo?: UploadInfo;
  scoreHints?: {
    references?: number;
    lastModifiedDays?: number;
  };
};

export type SearchHit = SymbolRecord & { score: number };
