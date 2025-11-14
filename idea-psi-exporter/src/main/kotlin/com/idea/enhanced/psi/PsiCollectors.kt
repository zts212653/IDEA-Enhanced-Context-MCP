package com.idea.enhanced.psi

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.intellij.ide.highlighter.JavaFileType
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.module.ModuleUtil
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.*
import com.intellij.psi.search.FileTypeIndex
import com.intellij.psi.search.GlobalSearchScope
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant

import com.intellij.openapi.application.ApplicationManager

class PsiSymbolCollector(private val project: Project) {
    private val logger = Logger.getInstance(PsiSymbolCollector::class.java)

    fun collect(indicator: ProgressIndicator): List<SymbolRecord> = ApplicationManager.getApplication().runReadAction<List<SymbolRecord>> {
        val scope = GlobalSearchScope.projectScope(project)
        val javaFiles: Collection<VirtualFile> =
            FileTypeIndex.getFiles(JavaFileType.INSTANCE, scope)
        val psiManager = PsiManager.getInstance(project)
        val total = javaFiles.size.coerceAtLeast(1)
        val results = mutableListOf<SymbolRecord>()
        javaFiles.forEachIndexed { index, file ->
            if (indicator.isCanceled) return@forEachIndexed
            indicator.fraction = index.toDouble() / total
            val psiFile = psiManager.findFile(file) as? PsiJavaFile ?: return@forEachIndexed
            psiFile.classes.forEach { psiClass ->
                SymbolBuilder.buildSymbol(psiClass)?.let(results::add)
            }
        }
        logger.info("Collected ${results.size} PSI symbols")
        results
    }
}

object SymbolBuilder {
    fun buildSymbol(psiClass: PsiClass): SymbolRecord? {
        val fqName = psiClass.qualifiedName ?: return null
        val module = ModuleUtil.findModuleForPsiElement(psiClass)
        val psiJavaFile = psiClass.containingFile as? PsiJavaFile
        val methods = psiClass.methods.map(::methodInfo)
        val fields = psiClass.fields.map(::fieldInfo)
        val annotations = psiClass.annotations.map(::annotationInfo)
        val summary = extractDoc(psiClass).ifBlank { "PSI class $fqName" }
        val imports = psiJavaFile?.importList?.allImportStatements
            ?.mapNotNull { it.importReference?.qualifiedName ?: it.text }
            ?: emptyList()
        val extends = psiClass.extendsListTypes.mapNotNull { it.canonicalText }
        val implements = psiClass.implementsListTypes.mapNotNull { it.canonicalText }
        val hierarchy = deriveHierarchy(psiClass)
        val dependencyInfo = DependencyInfo(
            imports = imports,
            extends = extends,
            implements = implements,
            fieldTypes = fields.mapNotNull { it.typeFqn ?: it.type }.distinct(),
            methodReturnTypes = methods.mapNotNull { it.returnTypeFqn ?: it.returnType }.distinct(),
            methodParameterTypes = methods.flatMap { method ->
                method.parameters.mapNotNull { it.typeFqn ?: it.type }
            }.distinct(),
        )
        val springInfo = deriveSpringInfo(annotations, fields)
        val relations = RelationInfo(
            calls = emptyList(),
            calledBy = emptyList(),
            references = dependencyInfo.imports,
        )
        val quality = QualityMetrics(
            methodCount = methods.size,
            fieldCount = fields.size,
            annotationCount = annotations.size,
        )
        return SymbolRecord(
            repoName = psiClass.project.name,
            fqn = fqName,
            kind = if (psiClass.isInterface) "INTERFACE" else "CLASS",
            module = module?.name ?: "default",
            modulePath = module?.moduleFilePath ?: "",
            packageName = psiJavaFile?.packageName ?: "",
            relativePath = psiJavaFile?.virtualFile?.path ?: "",
            filePath = psiJavaFile?.virtualFile?.path ?: "",
            summary = summary,
            javadoc = extractDoc(psiClass).takeIf { it.isNotBlank() },
            annotations = annotations,
            methods = methods,
            fields = fields,
            modifiers = psiClass.modifierList?.text?.split("\\s+".toRegex())?.filter { it.isNotBlank() }
                ?: emptyList(),
            imports = imports,
            extends = extends,
            implements = implements,
            dependencies = dependencyInfo,
            springInfo = springInfo,
            hierarchy = hierarchy,
            relations = relations,
            quality = quality,
        )
    }

    private fun extractDoc(element: PsiElement): String {
        val doc = (element as? PsiDocCommentOwner)?.docComment ?: return ""
        return doc.text.lines()
            .map { it.trim().trimStart('*').trim() }
            .filter { it.isNotBlank() && !it.startsWith("/**") && it != "*/" }
            .joinToString(" ")
    }

    private fun annotationInfo(annotation: PsiAnnotation): AnnotationInfo =
        AnnotationInfo(
            name = annotation.qualifiedName ?: annotation.text,
            fqn = annotation.qualifiedName,
            arguments = annotation.parameterList.attributes
                .joinToString { "${it.name ?: ""}=${it.value?.text ?: ""}" }
                .ifBlank { null },
        )

    private fun methodInfo(method: PsiMethod): MethodInfo {
        val parameters = method.parameterList.parameters.map {
            ParameterInfo(
                name = it.name ?: "param",
                type = it.type.presentableText,
                typeFqn = it.type.canonicalText,
            )
        }
        return MethodInfo(
            name = method.name,
            signature = method.text.substringBefore('{').trim(),
            visibility = methodVisibility(method),
            returnType = method.returnType?.presentableText ?: "void",
            returnTypeFqn = method.returnType?.canonicalText,
            parameters = parameters,
            annotations = method.annotations.map(::annotationInfo),
            javadoc = extractDoc(method).takeIf { it.isNotBlank() },
        )
    }

    private fun methodVisibility(method: PsiMethod): String =
        method.modifierList.text.split("\\s+".toRegex())
            .firstOrNull { it in setOf("public", "protected", "private") } ?: "package-private"

    private fun fieldInfo(field: PsiField): FieldInfo =
        FieldInfo(
            name = field.name ?: "field",
            type = field.type.presentableText,
            typeFqn = field.type.canonicalText,
            modifiers = field.modifierList?.text?.split("\\s+".toRegex())?.filter { it.isNotBlank() }
                ?: emptyList(),
            annotations = field.annotations.map(::annotationInfo),
        )
}

object BridgeUploader {
    private const val SCHEMA_VERSION = 2
    private val gson: Gson = GsonBuilder().disableHtmlEscaping().create()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()
    private val logger = Logger.getInstance(BridgeUploader::class.java)
    private val bridgeUrl: String =
        System.getenv("IDEA_BRIDGE_URL") ?: System.getProperty(
            "idea.bridge.url",
            "http://127.0.0.1:63000/api/psi/upload",
        )

    fun upload(projectName: String, symbols: List<SymbolRecord>) {
        val payload = PsiUploadPayload(
            schemaVersion = SCHEMA_VERSION,
            generatedAt = Instant.now().toString(),
            projectName = projectName,
            symbolCount = symbols.size,
            symbols = symbols,
        )
        val requestBody = gson.toJson(payload)
        val request = HttpRequest.newBuilder()
            .uri(URI.create(bridgeUrl))
            .timeout(Duration.ofSeconds(30))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(requestBody))
            .build()
        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) {
            throw IllegalStateException("Bridge upload failed: ${response.statusCode()} ${response.body()}")
        }
        logger.info("Uploaded ${symbols.size} symbols to bridge")
    }
}

data class PsiUploadPayload(
    val schemaVersion: Int,
    val generatedAt: String,
    val projectName: String,
    val symbolCount: Int,
    val symbols: List<SymbolRecord>,
)

data class SymbolRecord(
    val repoName: String,
    val fqn: String,
    val kind: String,
    val module: String,
    val modulePath: String,
    val packageName: String,
    val relativePath: String,
    val filePath: String,
    val summary: String,
    val javadoc: String?,
    val annotations: List<AnnotationInfo>,
    val methods: List<MethodInfo>,
    val fields: List<FieldInfo>,
    val modifiers: List<String>,
    val imports: List<String>,
    val extends: List<String>,
    val implements: List<String>,
    val dependencies: DependencyInfo,
    val springInfo: SpringInfo?,
    val hierarchy: HierarchyInfo?,
    val relations: RelationInfo?,
    val quality: QualityMetrics,
)

data class AnnotationInfo(
    val name: String,
    val fqn: String?,
    val arguments: String?,
)

data class MethodInfo(
    val name: String,
    val signature: String,
    val visibility: String,
    val returnType: String,
    val returnTypeFqn: String?,
    val parameters: List<ParameterInfo>,
    val annotations: List<AnnotationInfo>,
    val javadoc: String?,
)

data class ParameterInfo(
    val name: String,
    val type: String,
    val typeFqn: String?,
)

data class FieldInfo(
    val name: String,
    val type: String,
    val typeFqn: String?,
    val modifiers: List<String>,
    val annotations: List<AnnotationInfo>,
)

data class DependencyInfo(
    val imports: List<String>,
    val extends: List<String>,
    val implements: List<String>,
    val fieldTypes: List<String>,
    val methodReturnTypes: List<String>,
    val methodParameterTypes: List<String>,
)

data class SpringInfo(
    val isSpringBean: Boolean,
    val beanType: String?,
    val annotations: List<String>,
    val autoWiredDependencies: List<String>,
)

data class HierarchyInfo(
    val superClass: String?,
    val interfaces: List<String>,
    val isAbstract: Boolean,
    val isSealed: Boolean,
)

data class RelationInfo(
    val calls: List<String>,
    val calledBy: List<String>,
    val references: List<String>,
)

data class QualityMetrics(
    val methodCount: Int,
    val fieldCount: Int,
    val annotationCount: Int,
)

private val springBeanAnnotations = setOf(
    "org.springframework.stereotype.Component",
    "org.springframework.stereotype.Service",
    "org.springframework.stereotype.Repository",
    "org.springframework.stereotype.Controller",
    "org.springframework.web.bind.annotation.RestController",
    "org.springframework.context.annotation.Configuration",
)

private val injectionAnnotations = setOf(
    "org.springframework.beans.factory.annotation.Autowired",
    "jakarta.inject.Inject",
    "javax.inject.Inject",
    "jakarta.annotation.Resource",
    "javax.annotation.Resource",
)

private fun deriveHierarchy(psiClass: PsiClass): HierarchyInfo =
    HierarchyInfo(
        superClass = psiClass.superClass?.qualifiedName,
        interfaces = psiClass.interfaces.mapNotNull { it.qualifiedName ?: it.name },
        isAbstract = psiClass.hasModifierProperty(PsiModifier.ABSTRACT),
        isSealed = psiClass.hasModifierProperty(PsiModifier.SEALED),
    )

private fun deriveSpringInfo(
    annotations: List<AnnotationInfo>,
    fields: List<FieldInfo>,
): SpringInfo? {
    val beanAnnotations = annotations
        .mapNotNull { it.fqn ?: it.name }
        .filter { springBeanAnnotations.contains(it) }
    if (beanAnnotations.isEmpty()) {
        return null
    }
    val autoWired = fields.filter { field ->
        field.annotations.any { ann ->
            val fqn = ann.fqn ?: ann.name
            injectionAnnotations.contains(fqn)
        }
    }.map { it.name }
    return SpringInfo(
        isSpringBean = true,
        beanType = beanAnnotations.firstOrNull()?.substringAfterLast('.'),
        annotations = beanAnnotations,
        autoWiredDependencies = autoWired,
    )
}
