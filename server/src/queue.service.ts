import * as randomstring from "randomstring";
import * as winston from "winston";
import { QueryResult } from "../node_modules/@types/pg";
import { AxiosPromise } from "../node_modules/axios";
import * as db from "./db";
import { Queue, QueueItem, QueueDao } from "./queue";
import { SpotifyTrack, SpotifyCurrentTrack } from "./spotify";
import SpotifyService from "./spotify.service";
import { getCurrentSeconds } from "./util";
import Acl from "./acl";

export interface QueueTimeout {
    [accessToken: string]: NodeJS.Timer;
}

class QueueService {

    private static timeouts: QueueTimeout = {};
    public logger: winston.Logger;

    constructor (logger: winston.Logger) {
        this.logger = logger;
    }

    public async getQueue(passcode: string, forUpdate?: boolean): Promise<QueueDao> {
        let query = "SELECT * FROM queues WHERE id = $1";
        if (forUpdate) {
            query = "SELECT * FROM queues WHERE id = $1 FOR UPDATE";
        }

        try {
            const result: QueryResult = await db.query(query, [passcode]);
            if (result.rowCount === 1) {
                const queueDao: QueueDao = {
                    data: result.rows[0].data,
                    id: result.rows[0].id,
                    isPlaying: result.rows[0].is_playing,
                    owner: result.rows[0].owner
                }
                return queueDao;
            } else {
                throw Error("Unable to find queue with given passcode.");
            }
        } catch (err) {
            this.logger.error("Error occurred while fetching queue from database", { passcode });
            this.logger.error(err, { passcode });
            throw Error("Error occurred while fetching queue from database. Please try again later.");
        }
    }

    public getQueueBySpotifyId(spotifyUserId: string) {
        return db.query("SELECT * FROM queues WHERE owner = $1", [spotifyUserId]);
    }

    public create(spotify: SpotifyService, code: string) {
        return new Promise<QueueDao>((resolve, reject) => {
            let accessToken: string;
            let refreshToken: string;
            let expiresIn: number;

            this.logger.debug(`Creating new queue...`);

            spotify.getToken(code, "create")
            // Token received
            .then((response: any) => {
                accessToken = response.data.access_token;
                refreshToken = response.data.refresh_token;
                expiresIn = response.data.expires_in;
                this.logger.debug("Received access token...going to get username");
                return spotify.getUser(accessToken);
            })
            // User data received
            .then((response: any) => {
                const spotifyUserId = response.data.id;
                let passcode: string;
                let userId: string;

                this.logger.debug(`Found spotify userId...trying to find existing queues`, { id: spotifyUserId });

                // Check if this user already has a queue
                this.getQueueBySpotifyId(spotifyUserId)
                .then(result => {
                    if (result.rowCount === 1) {
                        const queue: QueueDao = result.rows[0];
                        queue.data.refreshToken = refreshToken;
                        queue.data.expiresIn = expiresIn;
                        queue.data.accessTokenAcquired = getCurrentSeconds();
                        passcode = queue.id;
                        userId = (queue.data.users.find(user => user.spotifyUserId === spotifyUserId))!.id;
                        this.logger.info(`Found existing queue`, { user: userId, passcode });
                        this.activateQueue(queue.data, accessToken, passcode).then(() => {
                            resolve(queue);
                        });
                    } else {
                        this.generatePasscode().then(passcode => {
                            userId = randomstring.generate();
                            this.logger.info(`Generated passcode`, { user: userId, passcode });
                            if (passcode) {
                                const queue: Queue = this.createQueueObject(spotifyUserId, accessToken,
                                    userId, refreshToken, expiresIn);
                                this.createQueue(passcode, spotifyUserId, queue).then(() => {
                                    resolve({ id: passcode, data: queue, isPlaying: false, owner: spotifyUserId });
                                }).catch(err => {
                                    this.logger.error(`Unable to insert queue into database`, { user: userId, passcode });
                                    this.logger.error(err, { user: userId, passcode });
                                    reject({ status: 500,
                                        message: "Error occured while inserting queue into database. Please try again later." });
                                });
                            } else {
                                throw new Error("Unable to generate unique passcode. Please try again later");
                            }
                        }).catch(err => {
                            this.logger.error(err, { user: userId, passcode });
                            reject({ status: 500, message: err.message });
                        });
                    }
                }).catch(err => {
                    this.logger.error(err);
                    reject( { status: 500, message: "Unable to create queue. Please try again in a moment." });
                });
            }).catch((err: any) => {
                this.logger.error(err.response.data);
                reject({ status: 500, message: "Failed to authenticate." });
            });
        });
    }

    public reactivate(spotify: SpotifyService, passcode: string, userId: string, code: string) {
        return new Promise<Queue>((resolve, reject) => {
            let accessToken: string;
            let refreshToken: string;
            let expiresIn: number;

            this.logger.info(`Reactivating queue...`, { user: userId, passcode });

            spotify.getToken(code, "reactivate")
            // Token received
            .then((response: any) => {
                accessToken = response.data.access_token;
                refreshToken = response.data.refresh_token;
                expiresIn = response.data.expires_in;
                this.logger.info("Access token received...going to get username", { user: userId, passcode });
                return spotify.getUser(accessToken);
            })
            // User data received
            .then((response: any) => {
                const spotifyUserId = response.data.id;
                this.logger.debug(`Found spotify userId ${spotifyUserId}...trying to reactivate`, { user: userId, passcode });

                this.getQueue(passcode, true).then(queueDao => {
                    if (queueDao.owner === spotifyUserId) {
                        queueDao.data.accessToken = accessToken;
                        queueDao.data.refreshToken = refreshToken;
                        queueDao.data.expiresIn = expiresIn;

                        if (!userId) {
                            userId = randomstring.generate();
                        }

                        // Update userId if cookie was missing or has changed
                        if (userId !== queueDao.data.owner) {
                            this.logger.info(`Queue owner's userid was missing or has changed from ${queueDao.data.owner}...syncing`,
                                { user: userId, passcode });
                            queueDao.data.owner = userId;
                            const i = queueDao.data.users.findIndex(user => user.spotifyUserId !== null);
                            const ownerUser = queueDao.data.users[i];
                            ownerUser.id = userId;
                            queueDao.data.users[i] = ownerUser;
                        }

                        this.updateQueue(queueDao.data, queueDao.isPlaying, passcode).then(() => {
                            this.logger.debug(`Successfully reactivated`, { user: userId, passcode });
                            resolve(queueDao.data);
                        }).catch(err => {
                            this.logger.error(`Unable to reactivate queue into database`, { user: userId, passcode });
                            this.logger.error(err, { user: userId, passcode });
                            reject({ status: 500, message: "Error occured while reactivating queue. Please try again later." });
                        });
                    } else {
                        reject({ status: 500, message: "Cannot reactivate queue since you're not the owner." });
                    }
                }).catch(err => {
                    reject({ status: 500, message: err.message });
                });
            }).catch((err: any) => {
                this.logger.error(err, { user: userId, passcode });
                reject({ status: 500, message: "Unable to get data from spotify. Please try again later." });
            });
        });
    }

    public createQueueObject(spotifyUserId: string, accessToken: string,
                             userId: string, refreshToken: string, expiresIn: number): Queue {
        return {
            owner: userId,
            accessToken,
            refreshToken,
            expiresIn,
            accessTokenAcquired: getCurrentSeconds(),
            currentTrack: null,
            name: "Queue 1",
            deviceId: null,
            queue: [],
            settings: {
                alwaysPlay: {
                    playlistId: null,
                    random: false
                },
                gamify: false
            },
            users: [
                {
                    id: userId,
                    spotifyUserId,
                    points: 0
                }
            ]
        };
    }

    public createQueue(passcode: string, spotifyUserId: string, queue: Queue) {
        this.logger.info(`Creating new queue`, { user: queue.owner, passcode });
        return db.query("INSERT INTO queues (id, owner, data) VALUES ($1, $2, $3)", [passcode, spotifyUserId, queue]);
    }

    public async generatePasscode(): Promise<string|null> {
        let loops = 10;
        let passcode = null;

        do {
            passcode = randomstring.generate({ readable: true, length: 8, charset: "alphanumeric" });
            const results = await db.query("SELECT 1 FROM queues WHERE id = $1", [passcode]);
            if (results.rowCount === 0) {
                return passcode;
            }
            loops--;
        } while (loops > 0);

        return null;
    }

    public join(passcode: string, userId: string) {
        return new Promise<boolean>((resolve, reject) => {
            this.getQueue(passcode, true).then(queueDao => {
                const queue: Queue = queueDao.data;

                // Check if queue is active
                if (!queue.accessToken) {
                    const isOwner = queue.owner === userId;
                    this.logger.debug(`Queue is not active. Not allowed to join. Is owner: ${isOwner}.`, { user: userId, passcode });
                    return reject({ status: 403, message: "Queue not active. The owner needs to reactivate it.", isOwner });
                }

                if (!userId) {
                    userId = randomstring.generate();
                }
                this.logger.info(`User joining to queue`, { user: userId, passcode });

                const user = {
                    id: userId,
                    spotifyUserId: null,
                    points: 0
                };

                if (!queue.users.find( user => user.id === userId)) {
                    this.logger.info(`User not yet part of queue...adding`, { user: userId, passcode });
                    queue.users.push(user);
                    this.updateQueue(queue, queueDao.isPlaying, passcode)
                    .then(() => {
                        resolve(false);
                    }).catch(err => {
                        this.logger.error("Error when inserting user into queue", { user: userId, passcode });
                        this.logger.error(err, { user: userId, passcode });
                        reject({ status: 400, message: "Error while adding user into database. Please try again later." });
                    });
                } else {
                    this.logger.info(`User already part of ${passcode}...authorize`, { user: userId, passcode });
                    resolve(queue.owner === userId);
                }
            }).catch(err => {
                reject({ status: 500, message: err.message });
            });
        });
    }

    public logout(passcode: string, user: string) {
        return new Promise((resolve, reject) => {
            this.getQueue(passcode, true).then(queueDao => {
                // Inactivate queue if logged out user is the owner
                const queue: Queue = queueDao.data;
                if (user === queue.owner) {
                    queue.currentTrack = null;
                    queue.accessToken = null;
                    queue.refreshToken = "";
                    this.updateQueue(queue, false, passcode).then(result => {
                        resolve();
                    }).catch(err => {
                        this.logger.error(err, { user, passcode });
                        reject({ status: 500, message: "Unable to save logout state to database. Please try again later." });
                    });
                } else {
                    resolve();
                }
            }).catch(err => {
                reject({ status: 500, message: err.message });
            });
        });
    }

    public isOwner(passcode: string, userId: string) {
        return new Promise((resolve, reject) => {
            this.getQueue(passcode).then(queueDao => {
                if (queueDao.data.owner === userId) {
                    resolve();
                } else {
                    reject({ status: 401, message: "Owner permission required for this action." });
                }
            }).catch(err => {
                reject({ status: 500, message: err.message });
            });
        });
    }

    public activateQueue(queue: Queue, accessToken: string, passcode: string) {
        return this.updateLoginState(queue, accessToken, passcode);
    }
    public inactivateQueue(queue: Queue, passcode: string) {
        return this.updateLoginState(queue, null, passcode);
    }

    public getCurrentTrack(passcode: string, user: string, spotify: SpotifyService, acl: Acl) {
        return new Promise((resolve, reject) => {
            this.getQueue(passcode, true).then(queueDao => {
                const queue: Queue = queueDao.data;

                // Get response if Spotify is playing
                spotify.currentlyPlaying(queue.accessToken!, user, passcode).then((currentTrack: SpotifyCurrentTrack) => {
                    // If our current track equals to spotify's current track
                    const owner = (queue.currentTrack && queue.currentTrack.track.id === currentTrack.item.id) ? 
                        queue.currentTrack.owner : user;
                    const votes = (queue.currentTrack) ? queue.currentTrack.votes : [];
                    queue.currentTrack = {
                        owner,
                        track: currentTrack.item,
                        votes
                    }

                    resolve({ currentTrack: queue.currentTrack, isPlaying: currentTrack.is_playing });

                    // Sync if we are not playing but spotify is
                    if (!QueueService.timeouts[queue.accessToken!] && currentTrack.is_playing) {
                        this.startPlaying(queue.accessToken!, passcode, user, currentTrack.item, spotify, acl);
                    }

                    this.logger.debug(`Found track ${currentTrack.item.id}. isPlaying: ${currentTrack.is_playing}, progress: ${currentTrack.progress_ms}ms`, { user, passcode });
                    
                    // Sync with Spotify
                    this.logger.debug(`Syncing currently playing track data with Spotify...`, { user, passcode });
                    this.updateQueue(queue, currentTrack.is_playing, passcode).then(() => {
                        this.logger.debug(`Current track state updated`, { user, passcode });
                    }).catch(err => {
                        this.logger.error("Failed to update current track state.", { user, passcode });
                        this.logger.error(err, { user, passcode });
                    });
                }).catch(() => {
                    this.logger.warn("Unable to get track progress from Spotify...resolve anyway.", { user, passcode });
                    resolve({ currentTrack: queue.currentTrack, isPlaying: queueDao.isPlaying });
                });
            }).catch(() => {
                reject({ status: 500, message: "Queue not found with the given passcode." });
            });
        });
    }

    public addToQueue(user: string, passcode: string, trackUri: string,
                      getTrackInfo: (accessToken: string, trackId: string) => AxiosPromise) {
        return new Promise((resolve, reject) => {
            this.getQueue(passcode, true).then(queueDao => {
                const queue: Queue = queueDao.data;
                const trackId = trackUri.split(":")[2];
                this.logger.info(`Getting track info for ${trackId}`, { user, passcode });
                getTrackInfo(queue.accessToken!, trackId).then(trackResponse => {
                    const track: SpotifyTrack = {
                        artist: trackResponse.data.artists[0].name,
                        id: trackUri,
                        duration: trackResponse.data.duration_ms,
                        cover: trackResponse.data.album.images[1].url,
                        name: trackResponse.data.name,
                        progress: 0
                    };
                    const item: QueueItem = {
                        track,
                        userId: user
                    };

                    this.logger.info(`Found track ${track.id}... pushing to queue...`, { user, passcode });
                    queue.queue.push(item);

                    db.query("UPDATE queues SET data = $1 WHERE id = $2", [queue, passcode]).then(() => {
                        this.logger.debug(`Track ${track.id} queued successfully`, { user, passcode });
                        resolve(queueDao);
                    }).catch(err => {
                        this.logger.error(err, { user, passcode });
                        reject({ status: 500, message: "Error when adding song to queue" });
                    });
                }).catch(err => {
                    this.logger.error(err, { user, passcode });
                    reject({ status: 500, message: "Unable to get track info for queued song from Spotify" });
                });
            }).catch(err => {
                reject({ status: 500, message: err.message });
            });
        });
    }

    public getAccessToken(id: string) {
        return new Promise<string>((resolve, reject) => {
            this.getQueue(id).then(queueDao => {
                resolve(queueDao.data.accessToken!);
            }).catch(err => {
                reject({ status: 500, message: err });
            })
        });
    }

    public setDevice(passcode: string, user: string, deviceId: string) {
        return new Promise((resolve, reject) => {
            this.getQueue(passcode, true).then(queueDao => {
                const queue: Queue = queueDao.data;
                queue.deviceId = deviceId;
                db.query("UPDATE queues SET data = $1 WHERE id = $2", [queue, passcode]).then(() => {
                    this.logger.debug(`Device set successfully`, { user, passcode });
                    resolve({ accessToken: queue.accessToken!, isPlaying: queueDao.isPlaying });
                }).catch(err => {
                    reject({ status: 500, message: "Unable to update new device to database. Please try again later." });
                });
            }).catch(err => {
                reject({ status: 500, message: err.message });
            });
        });
    }

    public startPlaying(accessToken: string,
                        passcode: string,
                        user: string,
                        currentTrack: SpotifyTrack,
                        spotify: SpotifyService,
                        acl: Acl) {
        if (QueueService.timeouts[accessToken]) {
            clearTimeout(QueueService.timeouts[accessToken]);
        }

        const timeLeft = currentTrack.duration - currentTrack.progress;

        this.logger.info(`Starting ${timeLeft} second timer for ${currentTrack.id}...`, { user, passcode });
        QueueService.timeouts[accessToken] = setTimeout(() =>
            this.checkTrackStatus(accessToken, passcode, user, currentTrack, spotify, acl),
            timeLeft - 1000
        );
    }

    public stopPlaying(queue: Queue, accessToken: string, passcode: string, user: string) {
        if (QueueService.timeouts[accessToken]) {
            clearInterval(QueueService.timeouts[accessToken]);
            delete QueueService.timeouts[accessToken];
        }

        queue.currentTrack = null;

        db.query("UPDATE queues SET data = $1, is_playing=$2 WHERE id = $3", [queue, false, passcode])
        .then(() => {
            this.logger.info(`Successfully stopped playing...`, { user, passcode });
        }).catch(err => {
            this.logger.error(`Unable to update playback state`, { user, passcode });
            this.logger.error(err, { passcode });
        });
    }

    public startOngoingTimers(spotify: SpotifyService, acl: Acl) {
        db.query("SELECT * FROM queues WHERE is_playing=true", []).then(res => {
            res.rows.forEach((row: QueueDao) => {
                if (row.data.accessToken) {
                    const track = row.data.currentTrack ? row.data.currentTrack.track : null;
                    this.checkTrackStatus(row.data.accessToken!, row.id, row.data.owner, track, spotify, acl);
                }
            });
        }).catch(err => {
            this.logger.error(err);
        });
    }

    public updateLoginState(queue: Queue, accessToken: string|null, passcode: string) {
        queue.accessToken = accessToken;
        return db.query("UPDATE queues SET data = $1 WHERE id = $2", [queue, passcode]);
    }

    public updateQueue(queue: Queue, isPlaying: boolean, passcode: string) {
        return db.query("UPDATE queues SET data = $1, is_playing=$2 WHERE id = $3", [queue, isPlaying, passcode]);
    }
    public updateQueueData(queue: Queue, passcode: string) {
        return db.query("UPDATE queues SET data = $1 WHERE id = $2", [queue, passcode]);
    }

    private startNextTrack(passcode: string, user: string, accessToken: string, spotify: SpotifyService, acl: Acl) {
        this.logger.info(`Starting next track`, { user, passcode });
        this.getQueue(passcode, true).then(queueDao => {
            if (queueDao.data.queue.length === 0) {
                this.logger.info("No more songs in queue. Stop playing.", { user, passcode });
                this.stopPlaying(queueDao.data, accessToken, passcode, user);
                return;
            }
            const queue: Queue = queueDao.data;
            const queuedItem = queue.queue.shift()!;
            queue.currentTrack = {
                track: queuedItem.track,
                owner: queuedItem.userId,
                votes: []
            };
    
            this.logger.info(`Next track is ${queuedItem.track.id}`, { user, passcode });
            this.updateQueue(queue, true, passcode).then(() => {
                // Check that access token is still valid
                spotify.isAuthorized(passcode, user, queue.accessTokenAcquired, queue.expiresIn, queue.refreshToken).then((response: any) => {
                    if (response) {
                        acl.saveAccessToken(queue, passcode, user, response.access_token, response.expires_in, response.refresh_token);
                        accessToken = response.access_token;
                    }
                    spotify.startSong(accessToken, queuedItem.track.id, queue.deviceId!).then(() => {
                        this.startPlaying(accessToken, passcode, user, queuedItem.track, spotify, acl);
                        this.logger.info(`Track ${queuedItem.track.id} successfully started.`, { user, passcode });
                    }).catch((err: any) => {
                        this.logger.info(err.response.data.error.message, { user, passcode });
                    });
                }).catch(err => {
                    this.logger.error(err, { user, passcode });
                });
            }).catch(err => {
                this.logger.error("Unable to update queue", { user, passcode });
                this.logger.error(err, { user, passcode });
            });
        }).catch(() => {
            this.logger.error("Unable to get queue when starting next track", { user, passcode });
        });
    }

    private checkTrackStatus(accessToken: string,
                            passcode: string,
                            user: string,
                            currentTrack: SpotifyTrack | null,
                            spotify: SpotifyService,
                            acl: Acl) {

        const currentTrackId = currentTrack ? currentTrack.id : "";
        this.logger.info(`Checking playback state for currently playing track ${currentTrackId}...`, { user, passcode });
        spotify.currentlyPlaying(accessToken, user, passcode).then((currentTrack: SpotifyCurrentTrack) => {
            const timeLeft = currentTrack.item.duration - currentTrack.progress_ms;

            // If song is already over (for some reason)
            if (!currentTrack.is_playing) {
                this.logger.info(`Track ${currentTrack.item.id} was already over...starting next`, { user, passcode });
                this.startNextTrack(passcode, user, accessToken, spotify, acl);
            } else if (timeLeft < 5000) {
                this.logger.info(`Less than 5 secs left on track ${currentTrack.item.id}...initiating timer to start the next song...`,
                    { user, passcode });
                // Start new song after timeLeft and check for that song's duration
                setTimeout(() => this.startNextTrack(passcode, user, accessToken, spotify, acl), timeLeft - 1000);
            } else {
                // If there's still time, check for progress again after a while
                this.logger.info(`Track ${currentTrack.item.id} still playing for ${(timeLeft / 1000)} secs. Checking again after that.`,
                    { user, passcode });
                QueueService.timeouts[accessToken] = setTimeout(() =>
                    this.checkTrackStatus(accessToken, passcode, user, currentTrack.item, spotify, acl),
                    timeLeft - 1000
                );
            }
        }).catch(err => {
            if (err.status == 404) {
                this.logger.info(err.message, { user, passcode });
            } else {
                this.logger.error("Unable to get currently playing track from spotify.", { user, passcode });
                this.logger.error(err, { user, passcode });
            }
        });
    }
}

export default QueueService;
