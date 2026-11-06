import { platform } from "@tauri-apps/plugin-os";
import { LucideProvider } from "lucide-react";
import { useEffect, useState } from "react";

import { useFirstLaunch } from "@/hooks/useFirstLaunch";
import { useLayout } from "@/hooks/useLayout";
import { useSettings } from "@/hooks/useSettings";
import { useWindowHeight, useWindowWidth } from "@/hooks/useWindowSize";
import { createCommandRegistry } from "@/lib/commands";
import {
    bottomPanelRenderedHeight,
    maxBottomPanelHeight,
    maxSidePanelWidth,
    RAIL_ITEMS,
    SIZES,
    sidePanelRenderedWidth,
} from "@/lib/layout";
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
    const { settings, warning, setTheme, setScriptsFolder } = useSettings();
    const firstLaunch = useFirstLaunch();
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
                        {layout.sidePanelVisible && (
                            <>
                                <SidePanel item={layout.activeRailItem} width={sideWidth} />
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
                        <div className={styles.center}>
                            <EditorArea>
                                {layout.activeRailItem === "settings" ? (
                                    <SettingsView
                                        theme={settings?.appearance.theme}
                                        onThemeChange={setTheme}
                                        scriptsFolder={settings?.editor.scripts_folder}
                                        onScriptsFolderChange={setScriptsFolder}
                                    />
                                ) : undefined}
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
                        {layout.inspectorVisible && <Inspector />}
                    </div>
                    <StatusBar layout={layout} warnings={warnings} />
                    {searchOpen && <SearchPopover onClose={() => setSearchOpen(false)} />}
                    <TooltipLayer />
                </div>
            </CommandsContext>
        </LucideProvider>
    );
}
