export type SymbolKind = "CLASS" | "INTERFACE";

export interface AnnotationInfo {
  name: string;
  fqn?: string;
  arguments?: string;
}

export interface ParameterInfo {
  name: string;
  type: string;
  typeFqn?: string;
}

export interface MethodInfo {
  name: string;
  signature: string;
  visibility: string;
  returnType: string;
  returnTypeFqn?: string;
  parameters: ParameterInfo[];
  javadoc?: string;
  annotations?: AnnotationInfo[];
  overrides?: string;
}

export interface FieldInfo {
  name: string;
  type: string;
  typeFqn?: string;
  modifiers: string[];
  annotations: AnnotationInfo[];
}

export interface TypeInfo {
  visibility: string;
  isAbstract: boolean;
  isFinal: boolean;
  isInterface: boolean;
  modifiers: string[];
}

export interface DependencyInfo {
  imports: string[];
  extends?: string[];
  implements?: string[];
  fieldTypes?: string[];
}

export interface SpringInfo {
  isSpringBean: boolean;
  beanType?: string;
  beanName?: string;
  annotations: string[];
  autoWiredDependencies: string[];
}

export interface HierarchyInfo {
  superClass?: string;
  interfaces: string[];
  isAbstract: boolean;
  isSealed: boolean;
}

export interface RelationInfo {
  calls: string[];
  calledBy: string[];
  references: string[];
}

export interface QualityMetrics {
  hasJavadoc: boolean;
  methodCount: number;
  fieldCount: number;
  summaryLength: number;
}

export interface SymbolRecord {
  repoName: string;
  fqn: string;
  kind: SymbolKind;
  module: string;
  modulePath: string;
  packageName: string;
  relativePath: string;
  filePath: string;
  summary: string;
  javadoc?: string;
  implements?: string[];
  extends?: string[];
  modifiers: string[];
  annotations: AnnotationInfo[];
  imports: string[];
  methods: MethodInfo[];
  fields: FieldInfo[];
  typeInfo: TypeInfo;
  dependencies: DependencyInfo;
  springInfo?: SpringInfo;
  hierarchy?: HierarchyInfo;
  relations?: RelationInfo;
  quality: QualityMetrics;
  lineStart: number;
  lineEnd: number;
}

export interface SearchResult extends SymbolRecord {
  score: number;
}

export interface SearchQuery {
  query: string;
  limit?: number;
  module?: string;
}
