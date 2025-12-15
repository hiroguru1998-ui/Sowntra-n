import { Server as SocketIOServer, Socket } from 'socket.io';
import * as Y from 'yjs';
import { prisma } from '../config/database';
import http from 'http';

interface ClientConnection {
  socket: Socket;
  boardId: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  color?: string;
  cursor?: { x: number; y: number };
}

// Store active connections per board
const boardConnections = new Map<string, Set<ClientConnection>>();

// Store Yjs documents per board
const boardDocs = new Map<string, Y.Doc>();

/**
 * Initialize Socket.IO server for real-time collaboration
 */
export function initWebSocketServer(server: http.Server): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: {
      origin: ['http://localhost:3000', 'http://localhost:4173', 'http://localhost:5173'],
      credentials: true
    },
    path: '/socket.io/'
  });

  console.log('✅ Socket.IO server initialized');

  io.on('connection', (socket: Socket) => {
    console.log('🔌 New Socket.IO connection:', socket.id);

    let clientConnection: ClientConnection | null = null;

    /**
     * Handle client joining a board
     */
    socket.on('join-board', async (data: { boardId: string; userId?: string; userName?: string; userEmail?: string }) => {
      try {
        const { boardId, userId, userName, userEmail } = data;

        if (!boardId) {
          socket.emit('error', { message: 'Board ID required' });
          return;
        }

        // Verify board access and get user role
        let userRole = 'viewer';
        let hasAccess = false;
        let dbUserId: string | undefined = undefined;

        if (userId) {
          try {
            // Look up database user ID from Firebase UID
            const dbUser = await prisma.user.findUnique({
              where: { firebaseUid: userId }
            });
            
            if (dbUser) {
              dbUserId = dbUser.id;
            }

            const board = await prisma.board.findUnique({
              where: { id: boardId },
              include: {
                members: {
                  where: dbUserId ? { userId: dbUserId } : undefined,
                  include: { user: true }
                }
              }
            });

            if (board) {
              // Check if user is owner
              if (dbUserId && board.ownerId === dbUserId) {
                userRole = 'owner';
                hasAccess = true;
              } else if (dbUserId) {
                // Check if user is a member
                const member = board.members.find(m => m.userId === dbUserId);
                if (member) {
                  userRole = member.role;
                  hasAccess = true;
                } else if (board.isPublic) {
                  // Public boards are accessible to everyone
                  hasAccess = true;
                }
              } else if (board.isPublic) {
                // Public boards are accessible to everyone
                hasAccess = true;
              }
            }
          } catch (error) {
            console.error('Error verifying board access:', error);
          }
        } else if (boardId) {
          // Allow anonymous access to public boards
          try {
            const board = await prisma.board.findUnique({
              where: { id: boardId }
            });
            hasAccess = board?.isPublic || false;
          } catch (error) {
            console.error('Error checking board access:', error);
          }
        }

        if (!hasAccess) {
          socket.emit('error', { message: 'Access denied to this board' });
          return;
        }

        // Join the socket room for this board
        socket.join(boardId);

        // Load or create Yjs document for the board
        let yDoc = boardDocs.get(boardId);
        
        if (!yDoc) {
          yDoc = new Y.Doc();
          
          // Try to load persisted state from database
          try {
            const board = await prisma.board.findUnique({
              where: { id: boardId }
            });

            if (board && board.yDocState) {
              Y.applyUpdate(yDoc, new Uint8Array(board.yDocState));
            }
          } catch (error) {
            console.error('Error loading board state:', error);
          }

          boardDocs.set(boardId, yDoc);

          // Auto-save document changes to database
          yDoc.on('update', async (update: Uint8Array) => {
            try {
              await prisma.board.update({
                where: { id: boardId },
                data: { 
                  yDocState: Buffer.from(update),
                  lastModified: new Date()
                }
              });
            } catch (error) {
              console.error('Error saving board state:', error);
            }
          });
        }

        // Create client connection
        const color = getRandomColor();
        clientConnection = {
          socket,
          boardId,
          userId: dbUserId || userId, // Use database user ID if available
          userName: userName || 'Anonymous',
          userEmail,
          color,
        };

        // Store user role and IDs in socket data for later use
        (socket as any).userRole = userRole;
        (socket as any).boardId = boardId;
        (socket as any).dbUserId = dbUserId;

        // Add to board connections
        // First, remove any existing connection for this user to prevent duplicates on refresh
        if (!boardConnections.has(boardId)) {
          boardConnections.set(boardId, new Set());
        } else {
          // Remove any existing connections for the same user (by userId or userEmail)
          const existingConnections = Array.from(boardConnections.get(boardId)!);
          existingConnections.forEach(conn => {
            if ((dbUserId && conn.userId === dbUserId) || 
                (userEmail && conn.userEmail === userEmail)) {
              boardConnections.get(boardId)!.delete(conn);
              // Notify others that the old connection is leaving
              conn.socket.to(boardId).emit('user-left', {
                userId: conn.userId,
                userName: conn.userName,
                userEmail: conn.userEmail,
                socketId: conn.socket.id
              });
            }
          });
        }
        boardConnections.get(boardId)!.add(clientConnection);

        // Send current document state to client
        const state = Y.encodeStateAsUpdate(yDoc);
        socket.emit('sync-board', {
          state: Array.from(state)
        });

        // Send list of ALL active users to the new client (including themselves)
        const allActiveUsers = Array.from(boardConnections.get(boardId) || [])
          .map(conn => ({
            userId: conn.userId,
            userName: conn.userName,
            userEmail: conn.userEmail,
            color: conn.color,
            cursor: conn.cursor,
            socketId: conn.socket.id,
            role: (conn.socket as any).userRole || 'viewer'
          }));

        // Send complete list to the new client
        socket.emit('active-users', { users: allActiveUsers });
        
        // Notify all OTHER clients about the new user joining
        socket.to(boardId).emit('user-joined', {
          userId: clientConnection.userId,
          userName: clientConnection.userName,
          userEmail,
          color: clientConnection.color,
          socketId: socket.id,
          role: userRole
        });
        
        // Send user role to client
        socket.emit('user-role', { role: userRole });

        console.log(`✅ User ${userName} (${socket.id}) joined board ${boardId}`);
      } catch (error) {
        console.error('Error in join-board:', error);
        socket.emit('error', { message: 'Failed to join board' });
      }
    });

    /**
     * Handle document sync
     */
    socket.on('sync-state', (data: { state: number[] }) => {
      if (!clientConnection) return;

      const yDoc = boardDocs.get(clientConnection.boardId);
      if (!yDoc) return;

      if (data.state) {
        Y.applyUpdate(yDoc, new Uint8Array(data.state));
      }
    });

    /**
     * Handle document updates
     */
    socket.on('board-update', (data: { update: number[] }) => {
      if (!clientConnection) return;

      const yDoc = boardDocs.get(clientConnection.boardId);
      if (!yDoc) return;

      if (data.update) {
        const update = new Uint8Array(data.update);
        Y.applyUpdate(yDoc, update);

        // Broadcast update to ALL clients on the same board (including the sender)
        // This ensures the initiator sees their own changes reflected back
        io.to(clientConnection.boardId).emit('board-update', {
          update: Array.from(update)
        });
      }
    });

    /**
     * Handle cursor position updates
     */
    socket.on('cursor-move', (data: { x: number; y: number }) => {
      if (!clientConnection) return;

      // Validate cursor coordinates
      if (data.x === undefined || data.y === undefined || 
          isNaN(data.x) || isNaN(data.y)) {
        return;
      }

      clientConnection.cursor = { x: data.x, y: data.y };

      // Broadcast cursor position to other clients
      socket.to(clientConnection.boardId).emit('cursor-update', {
        userId: clientConnection.userId,
        userName: clientConnection.userName,
        userEmail: clientConnection.userEmail,
        color: clientConnection.color,
        cursor: data,
        socketId: socket.id
      });
    });

    /**
     * Handle awareness updates (user presence)
     */
    socket.on('awareness-update', (data: { state: any }) => {
      if (!clientConnection) return;

      // Broadcast awareness to other clients
      socket.to(clientConnection.boardId).emit('awareness-update', {
        userId: clientConnection.userId,
        userName: clientConnection.userName,
        color: clientConnection.color,
        state: data.state,
        socketId: socket.id
      });
    });

    /**
     * Handle client disconnect
     */
    socket.on('disconnect', () => {
      if (!clientConnection) return;

      const { boardId, userId, userName, userEmail } = clientConnection;

      // Remove from board connections
      const connections = boardConnections.get(boardId);
      if (connections) {
        connections.delete(clientConnection);

        if (connections.size === 0) {
          boardConnections.delete(boardId);
          boardDocs.delete(boardId);
        }
      }

      // Notify other clients
      socket.to(boardId).emit('user-left', {
        userId,
        userName,
        userEmail,
        socketId: socket.id
      });

      // Update all remaining clients with new active users list
      const remainingUsers = Array.from(boardConnections.get(boardId) || [])
        .map(conn => ({
          userId: conn.userId,
          userName: conn.userName,
          userEmail: conn.userEmail,
          color: conn.color,
          cursor: conn.cursor, // Keep cursor for now, but it will be stale
          socketId: conn.socket.id,
          role: (conn.socket as any).userRole || 'viewer'
        }));
      
      // Broadcast updated list to all remaining clients (including empty list)
      io.to(boardId).emit('active-users', { users: remainingUsers });

      // Clear the client connection reference
      clientConnection = null;

      console.log(`👋 User ${userName} (${socket.id}) left board ${boardId}`);
    });
  });

  return io;
}

/**
 * Generate random color for user cursor/presence
 */
function getRandomColor(): string {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
    '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#52B788'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}
