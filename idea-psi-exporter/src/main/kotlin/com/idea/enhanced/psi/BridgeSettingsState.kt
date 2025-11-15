package com.idea.enhanced.psi

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

@State(
    name = "IdeaBridgeSettings",
    storages = [Storage("ideaBridgeSettings.xml")],
)
@Service(Service.Level.PROJECT)
class BridgeSettingsState : PersistentStateComponent<BridgeSettingsState.State> {

    companion object {
        const val DEFAULT_URL = "http://127.0.0.1:63000/api/psi/upload"
        const val DEFAULT_SCHEMA_VERSION = 2
        const val DEFAULT_BATCH_SIZE = 500

        fun getInstance(project: Project): BridgeSettingsState = project.service()
    }

    data class State(
        var bridgeUrl: String = DEFAULT_URL,
        var schemaVersion: Int = DEFAULT_SCHEMA_VERSION,
        var batchSize: Int = DEFAULT_BATCH_SIZE,
    )

    var bridgeUrl: String = DEFAULT_URL
    var schemaVersion: Int = DEFAULT_SCHEMA_VERSION
    var batchSize: Int = DEFAULT_BATCH_SIZE

    override fun getState(): State = State(bridgeUrl, schemaVersion, batchSize)

    override fun loadState(state: State) {
        bridgeUrl = state.bridgeUrl
        schemaVersion = state.schemaVersion
        batchSize = state.batchSize
    }
}
