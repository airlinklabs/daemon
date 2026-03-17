import { docker } from './utils';
import logger from '../../utils/logger';

// In-memory map: containerId → whether it's running.
// Updated in real time by Docker's event stream — no polling needed.
// Rebuilt from docker.listContainers() on startup so daemon restarts
// don't leave the map empty.
const stateMap = new Map<string, boolean>();

export function isContainerRunning(id: string): boolean | null {
    if (!stateMap.has(id)) return null;   // unknown — caller should inspect()
    return stateMap.get(id)!;
}

export function setContainerRunning(id: string, running: boolean) {
    stateMap.set(id, running);
}

// Seed the map from Docker's current container list on daemon startup.
async function seedStateMap() {
    try {
        const containers = await docker.listContainers({ all: true });
        for (const c of containers) {
            stateMap.set(c.Id, c.State === 'running');
            // Containers are keyed in this panel by their UUID name, not the
            // full Docker ID. Also index by the first Name segment if present.
            const name = (c.Names?.[0] || '').replace(/^\//, '');
            if (name) stateMap.set(name, c.State === 'running');
        }
        logger.info(`Container state map seeded with ${containers.length} containers`);
    } catch (err) {
        logger.error('Failed to seed container state map:', err);
    }
}

// Subscribe to Docker's event stream once and update the map on every
// container start/die/destroy event.
async function subscribeToDockerEvents() {
    try {
        const stream = await docker.getEvents({
            filters: JSON.stringify({ type: ['container'] }),
        });

        stream.on('data', (chunk: any) => {
            try {
                const event = JSON.parse(chunk.toString());
                const id   = event.id   as string;
                const name = (event.Actor?.Attributes?.name || '') as string;

                if (event.Action === 'start') {
                    stateMap.set(id,   true);
                    if (name) stateMap.set(name, true);
                } else if (event.Action === 'die' || event.Action === 'stop') {
                    stateMap.set(id,   false);
                    if (name) stateMap.set(name, false);
                } else if (event.Action === 'destroy') {
                    stateMap.delete(id);
                    if (name) stateMap.delete(name);
                }
            } catch {
                // Malformed event chunk — ignore
            }
        });

        stream.on('error', (err: Error) => {
            logger.error('Docker event stream error — reconnecting in 5s:', err);
            setTimeout(subscribeToDockerEvents, 5000);
        });

        stream.on('end', () => {
            logger.warn('Docker event stream ended — reconnecting in 2s');
            setTimeout(subscribeToDockerEvents, 2000);
        });

        logger.info('Docker event stream subscribed');
    } catch (err) {
        logger.error('Failed to subscribe to Docker events — retrying in 5s:', err);
        setTimeout(subscribeToDockerEvents, 5000);
    }
}

export async function initContainerStateMap() {
    await seedStateMap();
    await subscribeToDockerEvents();
}
