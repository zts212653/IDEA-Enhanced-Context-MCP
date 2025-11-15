package com.idea.enhanced.psi

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.util.ui.FormBuilder
import java.awt.Dimension
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JSpinner
import javax.swing.JTextField
import javax.swing.SpinnerNumberModel

class BridgeSettingsDialog(
    project: Project,
    initialState: BridgeSettingsState,
) : DialogWrapper(project) {

    private val urlField = JTextField(initialState.bridgeUrl)
    private val schemaSpinner = JSpinner(
        SpinnerNumberModel(
            initialState.schemaVersion,
            1,
            32,
            1,
        ),
    )
    private val batchSpinner = JSpinner(
        SpinnerNumberModel(
            initialState.batchSize,
            50,
            5000,
            50,
        ),
    )

    init {
        title = "IDEA Bridge Export Settings"
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel: JPanel = FormBuilder.createFormBuilder()
            .addLabeledComponent("Bridge upload URL:", urlField)
            .addLabeledComponent("Schema version:", schemaSpinner)
            .addLabeledComponent("Batch size:", batchSpinner)
            .panel
        panel.preferredSize = Dimension(450, 120)
        return panel
    }

    val bridgeUrl: String
        get() = urlField.text.trim().ifBlank { BridgeSettingsState.DEFAULT_URL }

    val schemaVersion: Int
        get() = (schemaSpinner.value as? Int) ?: BridgeSettingsState.DEFAULT_SCHEMA_VERSION

    val batchSize: Int
        get() = (batchSpinner.value as? Int) ?: BridgeSettingsState.DEFAULT_BATCH_SIZE
}
