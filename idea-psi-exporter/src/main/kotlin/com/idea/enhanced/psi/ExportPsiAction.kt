package com.idea.enhanced.psi

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.Messages

class ExportPsiAction : AnAction() {
    private val logger = Logger.getInstance(ExportPsiAction::class.java)

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Export PSI metadata", false) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = false
                try {
                    val collector = PsiSymbolCollector(project)
                    val records = collector.collect(indicator)
                    if (records.isEmpty()) {
                        Messages.showWarningDialog(project, "No symbols found to export.", "PSI Export")
                        return
                    }
                    val chunks = records.chunked(BridgeUploader.MAX_BATCH_SIZE)
                    val uploader = BridgeUploader()
                    chunks.forEachIndexed { index, chunk ->
                        indicator.fraction = index.toDouble() / chunks.size
                        uploader.upload(chunk)
                    }
                    Messages.showInfoMessage(
                        project,
                        "Exported ${records.size} symbols in ${chunks.size} batch(es).",
                        "PSI Export",
                    )
                } catch (ex: Exception) {
                    logger.warn("Failed to export PSI", ex)
                    Messages.showErrorDialog(project, "PSI export failed: ${ex.message}", "PSI Export")
                }
            }
        })
    }
}
