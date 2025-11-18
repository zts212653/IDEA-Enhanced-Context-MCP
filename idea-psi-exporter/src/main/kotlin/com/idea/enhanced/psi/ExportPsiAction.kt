package com.idea.enhanced.psi

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.Messages

class ExportPsiAction : AnAction() {
    private val logger = Logger.getInstance(ExportPsiAction::class.java)

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val settingsState = BridgeSettingsState.getInstance(project)
        val dialog = BridgeSettingsDialog(project, settingsState)
        if (!dialog.showAndGet()) {
            return
        }
        settingsState.bridgeUrl = dialog.bridgeUrl
        settingsState.schemaVersion = dialog.schemaVersion
        settingsState.batchSize = dialog.batchSize
        val batchSize = settingsState.batchSize.coerceAtLeast(50)

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Export PSI metadata", false) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = false
                try {
                    val collector = PsiSymbolCollector(project)
                    val records = collector.collect(indicator)
                    if (records.isEmpty()) {
                        showWarning(project, "No symbols found to export.")
                        return
                    }
                    val uploader = BridgeUploader(settingsState.bridgeUrl, settingsState.schemaVersion)
                    val chunks = records.chunked(batchSize)
                    chunks.forEachIndexed { index, chunk ->
                        if (indicator.isCanceled) return
                        indicator.fraction = index.toDouble() / chunks.size
                        uploader.upload(project.name, chunk, index + 1, chunks.size)
                    }
                    showInfo(project, "Exported ${records.size} symbols in ${chunks.size} batch(es).")
                } catch (ex: Exception) {
                    logger.warn("Failed to export PSI", ex)
                    showError(project, "PSI export failed: ${ex.message}")
                }
            }
        })
    }

    private fun showWarning(project: com.intellij.openapi.project.Project, message: String) {
        ApplicationManager.getApplication().invokeLater(
            {
                if (!project.isDisposed) {
                    Messages.showWarningDialog(project, message, "PSI Export")
                }
            },
            { project.isDisposed },
        )
    }

    private fun showInfo(project: com.intellij.openapi.project.Project, message: String) {
        ApplicationManager.getApplication().invokeLater(
            {
                if (!project.isDisposed) {
                    Messages.showInfoMessage(project, message, "PSI Export")
                }
            },
            { project.isDisposed },
        )
    }

    private fun showError(project: com.intellij.openapi.project.Project, message: String) {
        ApplicationManager.getApplication().invokeLater(
            {
                if (!project.isDisposed) {
                    Messages.showErrorDialog(project, message, "PSI Export")
                }
            },
            { project.isDisposed },
        )
    }
}
