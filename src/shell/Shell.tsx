import { platform } from "@tauri-apps/plugin-os";
import { LucideProvider } from "lucide-react";
import { useEffect, useState } from "react";

import { ConnectionsView } from "@/connections/ConnectionsView";
import { useConnections } from "@/hooks/useConnections";
import { useFirstLaunch } from "@/hooks/useFirstLaunch";
import { useLayout } from "@/hooks/useLayout";
import { useScriptTree } from "@/hooks/useScriptTree";
import { useSettings } from "@/hooks/useSettings";
import { useTabs } from "@/hooks/useTabs";
import { useWindowHeight, useWindowWidth } from "@/hooks/useWindowSize";
import { createCommandRegistry } from "@/lib/commands";
import { plural } from "@/lib/connectionFormat";
import {
    bottomPanelRenderedHeight,
    maxBottomPanelHeight,
    maxSidePanelWidth,
    RAIL_ITEMS,
    SIZES,
    sidePanelRenderedWidth,
} from "@/lib/layout";
import { Store } from "@/lib/store";
import { ScriptsPanel } from "@/scripts/ScriptsPanel";
import { ScriptsWorkspace } from "@/scripts/ScriptsWorkspace";
import { ActivityRail } from "@/shell/ActivityRail";
import { EditorArea } from "@/shell/EditorArea";
import { BottomPanel, Inspector, SidePanel } from "@/shell/Panels";
import { SearchPopover } from "@/shell/SearchPopover";
import { SettingsView } from "@/shell/SettingsView";
import { Splitter } from "@/shell/Splitter";
import { StatusBar } from "@/shell/StatusBar";
import { CommandsContext, RAIL_COMMANDS, SHELL_COMMANDS } from "@/shell/shellCommands";
import { TooltipLayer } from "@/shell/TooltipLayer";
import { TopBar } from "@/shell/TopBar";
import { WelcomeScreen } from "@/shell/WelcomeScreen";

import styles from "@/shell/Shell.module.css";

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
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.isComposing) return;

            if (registry.handleKey(e)) {
                e.preventDefault();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);

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
    const bottomHeight = bottomPanelRenderedHeight(layout, windowHeight);
    const warnings = [warning, saveError].filter((w): w is string => !!w);

    return (
        // One size and stroke for every icon in the shell.
        <LucideProvider size={16} strokeWidth={1.75}>
            <CommandsContext value={registry}>
                <div className={styles.shell}>
                    <TopBar />
                    <div className={styles.main}>
                        <ActivityRail layout={layout} />
                        {connectionsView && <ConnectionsView state={connections} />}
                        {!connectionsView && layout.sidePanelVisible && (
                            <>
                                <SidePanel item={layout.activeRailItem} width={sideWidth}>
                                    {layout.activeRailItem === "scripts" ? (
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
                                    max={maxSidePanelWidth(windowWidth, layout.inspectorVisible)}
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
                        {!connectionsView && layout.inspectorVisible && <Inspector />}
                    </div>
                    <StatusBar
                        layout={layout}
                        warnings={warnings}
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
                    />
                    {searchOpen && <SearchPopover onClose={() => setSearchOpen(false)} />}
                    <TooltipLayer />
                </div>
            </CommandsContext>
        </LucideProvider>
    );
}
