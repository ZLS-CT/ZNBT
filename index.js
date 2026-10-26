import {
    getCustomDataNBT,
    getItemStack,
    getSkyblockItemUUID,
    isOnHypixel,
    isLoaded,
    ChatDebug,
} from "../ZCore"
import { jvmObject, registerShared, clearObject } from "../ZCore/core"

const validNBTComponentTargets = {
    custom_data: {
        read(itemStack) {
            return getCustomDataNBT(itemStack) || new CompoundTag()
        },
        write(itemStack, tag) {
            itemStack.set(DataComponents.CUSTOM_DATA, CustomData.of(tag))
        }
    }
}

const NBT_SETTERS = {
    string: "putString",
    int: "putInt",
    double: "putDouble",
    float: "putFloat",
    long: "putLong",
    short: "putShort",
    byte: "putByte",
    boolean: "putBoolean",
}

const registeredNbtChanges = jvmObject("znbt.changes")
let isDebug = false

function unload() {
    clearObject(registeredNbtChanges)
}

function cacheNbtAction(skyblockUUID, key, action) {
    if (!registeredNbtChanges[skyblockUUID]) registeredNbtChanges[skyblockUUID] = {}
    if (!registeredNbtChanges[skyblockUUID][action.moduleName]) {
        registeredNbtChanges[skyblockUUID][action.moduleName] = {}
    }
    registeredNbtChanges[skyblockUUID][action.moduleName][key] = action
}

function getChildCompound(parent, key, create) {
    if (parent.contains(key)) {
        const existing = parent.getCompound(key).orElse(null)
        if (existing != null) return existing
    }
    if (!create) return null

    const child = new CompoundTag()
    parent.put(key, child)
    return child
}

function putNbtValue(compound, key, value, type) {
    const setter = NBT_SETTERS[type]
    if (!setter) throw new Error(`Unknown NBT type: ${type}`)

    const coerced = type == "string" ? `${value}` : type == "boolean" ? !!value : Number(value)
    compound[setter](key, coerced)
}

function applyNbtAction(root, action) {
    const parts = action.path.split(".").filter(part => part.length > 0)
    if (parts.length == 0) throw new Error("NBT path is empty")

    const last = parts.pop()
    let current = root
    for (const part of parts) {
        current = getChildCompound(current, part, action.action == "set")
        if (current == null) return
    }

    if (action.action == "remove") {
        current.remove(last)
        return
    }
    putNbtValue(current, last, JSON.parse(action.value), action.type)
}

function applyNbtActions(itemStack, actions) {
    const sorted = [...actions].sort((a, b) => {
        if (a.priority != b.priority) return a.priority - b.priority
        return a.moduleName.localeCompare(b.moduleName)
    })

    const byComponent = {}
    sorted.forEach(action => {
        if (!byComponent[action.component]) byComponent[action.component] = []
        byComponent[action.component].push(action)
    })

    let ok = true
    Object.keys(byComponent).forEach(componentName => {
        const handler = validNBTComponentTargets[componentName]
        if (!handler) {
            ok = false
            return
        }

        try {
            const tag = handler.read(itemStack)
            if (tag == null) return

            const before = `${tag}`
            byComponent[componentName].forEach(action => applyNbtAction(tag, action))
            if (`${tag}` != before) handler.write(itemStack, tag)
        } catch (e) {
            ok = false
            if (isDebug) ChatDebug(`[NBT:${componentName}] Error: ${JSON.stringify(e)}`)
        }
    })
    return ok
}

function nbtActionKey(action) {
    return `${action.moduleName}:${action.component}:${action.path}`
}

function persistNbtAction(itemStack, key, action) {
    const json = JSON.stringify(action)
    const handler = validNBTComponentTargets.custom_data
    const root = handler.read(itemStack)
    const store = getChildCompound(root, "nbtActions", true)

    const existing = store.getString(key).orElse(null)
    if (existing == json) return

    store.putString(key, json)
    handler.write(itemStack, root)
}

function registerNbtAction(itemStack, action) {
    const key = nbtActionKey(action)
    if (isOnHypixel()) {
        const skyblockUUID = getSkyblockItemUUID(itemStack)
        if (skyblockUUID != null) cacheNbtAction(skyblockUUID, key, action)
    }
    persistNbtAction(itemStack, key, action)
}

function loadNbtActions(itemStack) {
    const actions = {}
    const root = validNBTComponentTargets.custom_data.read(itemStack)
    if (root == null) return actions

    const store = getChildCompound(root, "nbtActions", false)
    if (store == null) return actions

    const keys = store.keySet().toArray()
    for (const key of keys) {
        const json = store.getString(key).orElse(null)
        if (!json) continue
        try {
            actions[key] = JSON.parse(json)
        } catch (e) { }
    }
    return actions
}

function replayNbtActions(itemStack) {
    let actions = null
    if (isOnHypixel()) {
        const skyblockUUID = getSkyblockItemUUID(itemStack)
        if (skyblockUUID != null) {
            if (registeredNbtChanges.hasOwnProperty(skyblockUUID)) {
                actions = {}
                Object.values(registeredNbtChanges[skyblockUUID]).forEach(moduleActions => {
                    Object.assign(actions, moduleActions)
                })
            } else {
                actions = loadNbtActions(itemStack)
                Object.entries(actions).forEach(([key, action]) => cacheNbtAction(skyblockUUID, key, action))
            }
        }
    }

    if (actions == null) actions = loadNbtActions(itemStack)

    const list = Object.values(actions)
    if (list.length == 0) return true
    return applyNbtActions(itemStack, list)
}

function applyNbtChange(item, moduleName, actionData) {
    const itemStack = getItemStack(item)
    if (itemStack == null) throw new Error("Invalid item")

    const action = Object.assign({ moduleName }, actionData)
    if (action.moduleName == null || action.path == null || action.action == null) {
        throw new Error("Invalid NBT action: missing moduleName, path, or action")
    }
    if (action.path.split(".")[0] == "nbtActions") {
        throw new Error("The nbtActions key is reserved")
    }
    if (!validNBTComponentTargets[action.component]) {
        throw new Error(`Unknown NBT component: ${action.component}`)
    }
    if (action.action == "set" && !NBT_SETTERS[action.type]) {
        throw new Error(`Unknown or missing NBT type: ${action.type}`)
    }

    registerNbtAction(itemStack, action)
    return applyNbtActions(itemStack, [action])
}

function replayAllSlots() {
    const player = Client.getMinecraft().player
    if (player == null) return

    player.containerMenu.slots.forEach(slot => {
        const itemStack = slot.getItem()
        if (itemStack == null || itemStack.isEmpty()) return
        replayNbtActions(itemStack)
    })
}

registerShared("znbt.worldUnload", "worldUnload", () => { unload() })
registerShared("znbt.gameUnload", "gameUnload", () => { unload() })
registerShared("znbt.tick", "tick", () => {
    if (!isLoaded()) return
    try {
        replayAllSlots()
    } catch (e) {
        if (isDebug) ChatDebug(`[NBTTick] Error: ${JSON.stringify(e)}`)
    }
})
registerShared("znbt.tooltip", "ZCore:RenderItemTooltip", (itemStack) => {
    try {
        replayNbtActions(itemStack)
    } catch (e) {
        if (isDebug) ChatDebug(`[RenderItemTooltip] Error: ${JSON.stringify(e)}`)
    }
})

export default NBT = {
    set: function(item, moduleName, path, value, type, component = "custom_data", priority = 0) {
        if (value == undefined) throw new Error("ZNBT.set: value is undefined")
        if (type == undefined) throw new Error("ZNBT.set: type is undefined")
        if (component == undefined) throw new Error("ZNBT.set: component is undefined")
        return applyNbtChange(item, moduleName, {
            action: "set",
            component,
            path,
            type,
            value: JSON.stringify(value),
            priority,
        })
    },
    remove: function(item, moduleName, path, component = "custom_data", priority = 0) {
        if (component == undefined) throw new Error("ZNBT.remove: component is undefined")
        return applyNbtChange(item, moduleName, {
            action: "remove",
            component,
            path,
            type: null,
            value: null,
            priority,
        })
    },
    replay: function(item) {
        const itemStack = getItemStack(item)
        if (itemStack == null) return false
        return replayNbtActions(itemStack)
    },
    clearAll: function() {
        clearObject(registeredNbtChanges)
    },
    clearModule: function(moduleName) {
        Object.keys(registeredNbtChanges).forEach(uuid => {
            delete registeredNbtChanges[uuid][moduleName]
        })
    },
}
