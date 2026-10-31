/**
 * A folder on the writer's own computer (a checkout of a repository, say) that the writer has allowed the page to read.
 * The page reads from it only what the writer picks, and never writes to it. The reader is held for the session; nothing about it is stored
 * in the article except the file's address, written as `<folder name>/<path>`, which is how a file is found again.
 */
export interface FolderReader {
    /** The folder's own name, the first part of every file's address. */
    name: string;
    /** Paths of the readable files under the folder, relative and with `/` separators. */
    files(): Promise<string[]>;
    /** The file's text, or undefined when it is gone or cannot be read. */
    read(path: string): Promise<string | undefined>;
}
/** The most files a listing keeps; a repository with more is listed level by level and the deepest are left out. */
export declare const MAX_FILES = 20000;
export declare function isSkippedFolder(name: string): boolean;
/** The address a folder file is stored under. */
export declare function folderFileAddress(folderName: string, path: string): string;
/** The path inside the folder for an address stored by folderFileAddress, or undefined when the address belongs to another folder. */
export declare function pathInFolder(folderName: string, address: string): string | undefined;
/**
 * Walks a folder through a lister that says, for a directory path, its entries and which are folders. Skipped folders are left out, only files the
 * Write page can read as text or code are kept, and the walk stops at a fixed depth and file count.
 */
export declare function walkFolder(list: (dir: string) => Promise<{
    name: string;
    directory: boolean;
}[]>): Promise<string[]>;
/**
 * A reader over a file system that can list a directory with each entry marked as a file or a folder (the desktop app's `workspace_list_dir`),
 * so subfolders are walked into without guessing which names are folders. `root` is the folder's absolute path.
 */
export declare function folderFromListing(fs: {
    readTextFile(path: string): Promise<string | undefined>;
    listDir(path: string): Promise<{
        name: string;
        directory: boolean;
    }[]>;
}, root: string, name: string): FolderReader;
/**
 * A reader over a file-system backend that has only readTextFile and readDir (the desktop app's). It cannot tell a folder from a file by name, so a
 * path that cannot be listed as a directory is taken to be a file.
 */
export declare function folderFromFsBackend(fs: {
    readTextFile(path: string): Promise<string | undefined>;
    readDir(path: string): Promise<string[]>;
}, root: string, name: string): FolderReader;
/** The files whose path contains every word typed (any case), shortest path first; at most `limit`. A plain filter, no meaning is read from the words. */
export declare function matchFolderFiles(files: string[], query: string, limit?: number): string[];
