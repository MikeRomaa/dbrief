import { platform } from "@tauri-apps/plugin-os";
import { LucideProvider } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ConnectionsView } from "@/components/connections/ConnectionsView";
import { ExplorerPanel } from "@/components/explorer/ExplorerPanel";
import { ScriptsPanel } from "@/components/scripts/ScriptsPanel";
import { ScriptsWorkspace } from "@/components/scripts/ScriptsWorkspace";
import { ActivityRail } from "@/components/shell/ActivityRail";
import { EditorArea } from "@/components/shell/EditorArea";
import { BottomPanel, Inspector, SidePanel } from "@/components/shell/Panels";
import { SearchPopover } from "@/components/shell/SearchPopover";
import { SettingsView } from "@/components/shell/SettingsView";
import { Splitter } from "@/components/shell/Splitter";
import { StatusBar } from "@/components/shell/StatusBar";
import { TooltipLayer } from "@/components/shell/TooltipLayer";
import { TopBar } from "@/components/shell/TopBar";
import { WelcomeScreen } from "@/components/shell/WelcomeScreen";
import { CommandsContext } from "@/hooks/useCommands";
import { useConnectFlow } from "@/hooks/useConnectFlow";
import { useConnections } from "@/hooks/useConnections";
import { useFirstLaunch } from "@/hooks/useFirstLaunch";
import { useLayout } from "@/hooks/useLayout";
import { useScriptTree } from "@/hooks/useScriptTree";
import { useSettings } from "@/hooks/useSettings";
import { useStore } from "@/hooks/useStore";
import { useTabs } from "@/hooks/useTabs";
import { useWindowHeight, useWindowWidth } from "@/hooks/useWindowSize";
import { activeConnection, explorerConnection } from "@/lib/connections/activeConnection";
import { colorTagVar, plural } from "@/lib/connections/connectionFormat";
import { listenForSchemaChanges } from "@/lib/schema/schemaStore";
import { createCommandRegistry } from "@/lib/shell/commands";
import {
    bottomPanelRenderedHeight,
    inspectorRenderedWidth,
    maxBottomPanelHeight,
    maxInspectorWidth,
    maxSidePanelWidth,
    RAIL_ITEMS,
    SIZES,
    sidePanelRenderedWidth,
} from "@/lib/shell/layout";
import { RAIL_COMMANDS, SHELL_COMMANDS } from "@/lib/shell/shellCommands";
import { panelRequest, stagedPanel } from "@/lib/shell/staged";
import { requestView, revealColumn, type TableRef, tableKey } from "@/lib/tabs/tableTabs";
import { Store } from "@/lib/util/store";

import styles from "@/components/shell/Shell.module.css";

export function Shell() {
    const { layout, dispatch, loaded, saveError } = useLayout();
    const { settings, warning, setTheme, setScriptsFolder, update: updateSettings } = useSettings();
    const firstLaunch = useFirstLaunch();
    const connections = useConnections();
    const tabs = useTabs();
    const [scriptChanges] = useState(() => new Store<string[]>([]));
    const scriptTree = useScriptTree(settings?.editor.scripts_folder, (paths) => scriptChanges.set(paths));
    const [registry] = useState(() => createCommandRegistry(platform()));
    const [searchOpen, setSearchOpen] = useState(false);
    const windowWidth = useWindowWidth();
    const windowHeight = useWindowHeight();
    const activeId = useStore(activeConnection);
    const searchConnect = useConnectFlow(connections.persistentSecrets, connections.report);

    // Schema loads (after connect, DDL, or Refresh) reload the Explorer and land in the Log.
    const names = useRef(connections.index);
    names.current = connections.index;
    // Editing a value that needs the inspector shows it.
    const inspectorShown = useRef(layout.inspectorVisible);
    inspectorShown.current = layout.inspectorVisible;
    useEffect(
        () =>
            panelRequest.subscribe(() => {
                if (panelRequest.get()?.panel === "inspector" && !inspectorShown.current) {
                    dispatch({ type: "toggleInspector" });
                }
            }),
        [dispatch],
    );
    const staged = useStore(stagedPanel);

    useEffect(() => listenForSchemaChanges((id) => names.current.connections.get(id)?.name ?? "Schema"), []);

    // Tables open in the editor area, which the Connections view hides.
    const openTable = useCallback(
        (table: TableRef, preview: boolean, view?: "data" | "columns", column?: string) => {
            const key = tableKey(table);
            tabs.dispatch({ type: "open", path: key, preview });
            if (layout.activeRailItem === "connections" || layout.activeRailItem === "settings") {
                dispatch({ type: "openRailItem", item: "explorer" });
            }
            if (view) requestView.set({ key, view });
            if (column) revealColumn.set({ key, column });
        },
        [tabs.dispatch, dispatch, layout.activeRailItem],
    );

    useEffect(() => {
        const offs = [
            registry.register({
                ...SHELL_COMMANDS.toggleSidePanel,
                run: () => dispatch({ type: "toggleSidePanel" }),
            }),
            registry.register({
                ...SHELL_COMMANDS.toggleBottomPanel,
                run: () => dispatch({ type: "toggleBottomPanel" }),
            }),
            registry.register({
                ...SHELL_COMMANDS.toggleInspector,
                run: () => dispatch({ type: "toggleInspector" }),
            }),
            registry.register({
                ...SHELL_COMMANDS.search,
                run: () => setSearchOpen((open) => !open),
            }),
            ...RAIL_ITEMS.map((item) =>
                registry.register({
                    ...RAIL_COMMANDS[item],
                    run: () => dispatch({ type: "selectRailItem", item }),
                }),
            ),
        ];
        // Shell shortcuts are global: they run in the capture phase, before the editor, grid, inputs or
        // any other focused component can handle or cancel the key, and the key goes no further.
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.isComposing) return;

            if (registry.handleKey(e)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };

        window.addEventListener("keydown", onKeyDown, true);
        return () => {
            window.removeEventListener("keydown", onKeyDown, true);

            for (const off of offs) off();
        };
    }, [registry, dispatch]);

    if (!loaded || !firstLaunch.loaded) {
        return null;
    }

    if (firstLaunch.needed) {
        const finishWelcome = async (scriptsFolder: string) => {
            setScriptsFolder(scriptsFolder);
            dispatch({ type: "openRailItem", item: "connections" });
            await firstLaunch.complete();
        };

        return (
            <LucideProvider size={16} strokeWidth={1.75}>
                <div className={styles.welcome}>
                    <TopBar />
                    <WelcomeScreen theme={settings?.appearance.theme} onThemeChange={setTheme} onDone={finishWelcome} />
                    <TooltipLayer />
                </div>
            </LucideProvider>
        );
    }

    // Connections is a full view: it takes the place of the side panel, editor and inspector.
    const connectionsView = layout.activeRailItem === "connections";
    const sideWidth = sidePanelRenderedWidth(layout, windowWidth);
    const inspectorWidth = inspectorRenderedWidth(layout, windowWidth);
    const inspectorMax = maxInspectorWidth(windowWidth, connectionsView ? 0 : sideWidth);
    const bottomHeight = bottomPanelRenderedHeight(layout, windowHeight);
    const warnings = [warning, saveError].filter((w): w is string => !!w);
    const active = activeId ? connections.index.connections.get(activeId) : undefined;
    const tint =
        !connectionsView && settings?.appearance.tint_bars ? colorTagVar(active?.color_tag ?? null) : undefined;

    return (
        // One size and stroke for every icon in the shell.
        <LucideProvider size={16} strokeWidth={1.75}>
            <CommandsContext value={registry}>
                <div className={styles.shell}>
                    <TopBar tint={tint} />
                    <div className={styles.main}>
                        <ActivityRail layout={layout} />
                        {connectionsView && <ConnectionsView state={connections} />}
                        {!connectionsView && layout.sidePanelVisible && (
                            <>
                                <SidePanel item={layout.activeRailItem} width={sideWidth}>
                                    {layout.activeRailItem === "explorer" ? (
                                        <ExplorerPanel connections={connections} onOpenTable={openTable} />
                                    ) : layout.activeRailItem === "scripts" ? (
                                        <ScriptsPanel
                                            tree={scriptTree.tree}
                                            error={scriptTree.error}
                                            activePath={tabs.tabs.active}
                                            reload={scriptTree.reload}
                                            onOpen={(path, preview) => tabs.dispatch({ type: "open", path, preview })}
                                            onRenamed={(from, to) => tabs.dispatch({ type: "renamed", from, to })}
                                            onRemoved={(path) => tabs.dispatch({ type: "removed", path })}
                                        />
                                    ) : undefined}
                                </SidePanel>
                                <Splitter
                                    orientation="vertical"
                                    label="Resize side panel"
                                    controls="side-panel"
                                    value={sideWidth}
                                    min={SIZES.sidePanel.min}
                                    max={maxSidePanelWidth(windowWidth, inspectorWidth)}
                                    direction={1}
                                    valueText={`${sideWidth} pixels`}
                                    onChange={(width) => dispatch({ type: "setSidePanelWidth", width })}
                                />
                            </>
                        )}
                        <div className={styles.center} hidden={connectionsView}>
                            <EditorArea>
                                {/* Script tabs stay mounted under Settings, so editors and sessions survive. */}
                                {settings && tabs.loaded && (
                                    <ScriptsWorkspace
                                        tabs={tabs.tabs}
                                        dispatch={tabs.dispatch}
                                        connections={connections}
                                        settings={settings}
                                        changes={scriptChanges}
                                        hidden={layout.activeRailItem === "settings"}
                                    />
                                )}
                                {layout.activeRailItem === "settings" && (
                                    <SettingsView
                                        settings={settings}
                                        onThemeChange={setTheme}
                                        onScriptsFolderChange={setScriptsFolder}
                                        onChange={updateSettings}
                                    />
                                )}
                            </EditorArea>
                            <Splitter
                                orientation="horizontal"
                                label="Resize bottom panel"
                                controls="bottom-panel"
                                value={bottomHeight}
                                min={SIZES.bottomPanel.collapsed}
                                max={maxBottomPanelHeight(windowHeight)}
                                direction={-1}
                                valueText={layout.bottomPanelCollapsed ? "Collapsed" : `${bottomHeight} pixels`}
                                onChange={(height) => dispatch({ type: "setBottomPanelHeight", height })}
                                onDoubleClick={() => dispatch({ type: "toggleBottomPanel" })}
                            />
                            {/* The 1px splitter line is part of the bottom panel's height. */}
                            <BottomPanel layout={layout} height={bottomHeight - 1} />
                        </div>
                        {!connectionsView && layout.inspectorVisible && (
                            <>
                                <Splitter
                                    orientation="vertical"
                                    label="Resize inspector"
                                    controls="inspector"
                                    value={inspectorWidth}
                                    min={SIZES.inspector.min}
                                    max={inspectorMax}
                                    direction={-1}
                                    valueText={`${inspectorWidth} pixels`}
                                    // Capped here so dragging never squeezes the side panel.
                                    onChange={(width) =>
                                        dispatch({ type: "setInspectorWidth", width: Math.min(width, inspectorMax) })
                                    }
                                />
                                <Inspector settings={settings} width={inspectorWidth} />
                            </>
                        )}
                    </div>
                    <StatusBar
                        layout={layout}
                        warnings={warnings}
                        staged={connectionsView ? 0 : (staged?.counts.total ?? 0)}
                        summary={
                            connectionsView
                                ? [
                                      plural(connections.sessions.length, "open session"),
                                      `${plural(connections.index.connections.size, "connection")} in ${plural(connections.index.folders.size, "folder")}`,
                                      connections.persistentSecrets
                                          ? "Passwords in system keychain"
                                          : "Passwords kept until quit",
                                  ]
                                : undefined
                        }
                        connection={
                            active
                                ? {
                                      name: active.name,
                                      accessLevel: active.access_level,
                                      serverVersion:
                                          connections.sessions.find((x) => x.connection_id === active.id)
                                              ?.server_version ??
                                          active.server_version ??
                                          null,
                                      connected: connections.sessions.some(
                                          (x) => x.background && x.connection_id === active.id,
                                      ),
                                  }
                                : null
                        }
                        tint={tint}
                    />
                    {searchOpen && (
                        <SearchPopover
                            connections={connections}
                            scripts={scriptTree.tree}
                            onOpenConnection={(id) => {
                                explorerConnection.set(id);
                                dispatch({ type: "openRailItem", item: "explorer" });
                                const connection = connections.index.connections.get(id);
                                const connected = connections.sessions.some(
                                    (x) => x.background && x.connection_id === id,
                                );
                                if (connection && !connected) {
                                    void searchConnect.connect(connection, {}, "background");
                                }
                            }}
                            onOpenTable={(table, column) => openTable(table, false, undefined, column)}
                            onOpenScript={(path) => {
                                tabs.dispatch({ type: "open", path, preview: false });
                                if (layout.activeRailItem === "connections" || layout.activeRailItem === "settings") {
                                    dispatch({ type: "openRailItem", item: "scripts" });
                                }
                            }}
                            onClose={() => setSearchOpen(false)}
                        />
                    )}
                    {searchConnect.prompt}
                    <TooltipLayer />
                </div>
            </CommandsContext>
        </LucideProvider>
    );
}
