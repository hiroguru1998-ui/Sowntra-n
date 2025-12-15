import { Request, Response } from 'express';
import { prisma } from '../config/database';
import * as Y from 'yjs';

/**
 * Get all boards for the authenticated user
 */
export async function listBoards(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.dbUserId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Get boards owned by user or where user is a member
    const ownedBoards = await prisma.board.findMany({
      where: { ownerId: userId },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            profileImage: true,
            firebaseUid: true
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                profileImage: true,
                firebaseUid: true
              }
            }
          }
        }
      },
      orderBy: { lastModified: 'desc' }
    });

    const sharedBoards = await prisma.board.findMany({
      where: {
        members: {
          some: { userId: userId }
        }
      },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            profileImage: true,
            firebaseUid: true
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                profileImage: true,
                firebaseUid: true
              }
            }
          }
        }
      },
      orderBy: { lastModified: 'desc' }
    });

    res.json({
      ownedBoards,
      sharedBoards
    });
  } catch (error) {
    console.error('Error listing boards:', error);
    res.status(500).json({ error: 'Failed to fetch boards' });
  }
}

/**
 * Create a new board
 */
export async function createBoard(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.dbUserId;
    const { title, description, isPublic } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!title) {
      res.status(400).json({ error: 'Board title is required' });
      return;
    }

    // Create new Yjs document for the board
    const yDoc = new Y.Doc();
    const yDocState = Y.encodeStateAsUpdate(yDoc);

    // Create board
    const board = await prisma.board.create({
      data: {
        title,
        description: description || null,
        isPublic: isPublic || false,
        ownerId: userId,
        yDocState: Buffer.from(yDocState)
      },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            profileImage: true
          }
        }
      }
    });

    res.status(201).json(board);
  } catch (error) {
    console.error('Error creating board:', error);
    res.status(500).json({ error: 'Failed to create board' });
  }
}

/**
 * Get a specific board by ID
 */
export async function getBoard(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = req.user?.dbUserId;

    const board = await prisma.board.findUnique({
      where: { id },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            profileImage: true,
            firebaseUid: true
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                profileImage: true,
                firebaseUid: true
              }
            }
          }
        },
        assets: true
      }
    });

    if (!board) {
      res.status(404).json({ error: 'Board not found' });
      return;
    }

    // Check if user has access
    const hasAccess = 
      board.isPublic ||
      board.ownerId === userId ||
      board.members.some(m => m.userId === userId);

    if (!hasAccess && userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Don't send binary yDocState to client (handled by WebSocket)
    const { yDocState, ...boardData } = board;

    res.json(boardData);
  } catch (error) {
    console.error('Error fetching board:', error);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
}

/**
 * Update board metadata
 */
export async function updateBoard(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = req.user?.dbUserId;
    const { title, description, thumbnail, isPublic } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Check if user owns the board or has editor access
    const board = await prisma.board.findUnique({
      where: { id },
      include: {
        members: true
      }
    });

    if (!board) {
      res.status(404).json({ error: 'Board not found' });
      return;
    }

    const isOwner = board.ownerId === userId;
    const isEditor = board.members.some(
      m => m.userId === userId && (m.role === 'editor' || m.role === 'owner')
    );

    if (!isOwner && !isEditor) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Update board
    const updatedBoard = await prisma.board.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(description !== undefined && { description }),
        ...(thumbnail !== undefined && { thumbnail }),
        ...(isPublic !== undefined && { isPublic })
      }
    });

    res.json(updatedBoard);
  } catch (error) {
    console.error('Error updating board:', error);
    res.status(500).json({ error: 'Failed to update board' });
  }
}

/**
 * Delete a board
 */
export async function deleteBoard(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = req.user?.dbUserId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Check if user owns the board
    const board = await prisma.board.findUnique({
      where: { id }
    });

    if (!board) {
      res.status(404).json({ error: 'Board not found' });
      return;
    }

    if (board.ownerId !== userId) {
      res.status(403).json({ error: 'Only the owner can delete this board' });
      return;
    }

    // Delete board (cascade will handle related records)
    await prisma.board.delete({
      where: { id }
    });

    res.json({ message: 'Board deleted successfully' });
  } catch (error) {
    console.error('Error deleting board:', error);
    res.status(500).json({ error: 'Failed to delete board' });
  }
}

/**
 * Add member to board
 */
export async function addBoardMember(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = req.user?.dbUserId;
    const { email, role } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Check if current user owns the board
    const board = await prisma.board.findUnique({
      where: { id }
    });

    if (!board) {
      res.status(404).json({ error: 'Board not found' });
      return;
    }

    if (board.ownerId !== userId) {
      res.status(403).json({ error: 'Only the owner can add members' });
      return;
    }

    // Find user to add
    const userToAdd = await prisma.user.findUnique({
      where: { email }
    });

    if (!userToAdd) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Add member
    const member = await prisma.boardMember.create({
      data: {
        boardId: id,
        userId: userToAdd.id,
        role: role || 'viewer'
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            profileImage: true
          }
        }
      }
    });

    res.status(201).json(member);
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(400).json({ error: 'User is already a member of this board' });
      return;
    }
    console.error('Error adding board member:', error);
    res.status(500).json({ error: 'Failed to add board member' });
  }
}

/**
 * Remove member from board
 */
export async function removeBoardMember(req: Request, res: Response): Promise<void> {
  try {
    const { id, memberId } = req.params;
    const userId = req.user?.dbUserId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Check if current user owns the board
    const board = await prisma.board.findUnique({
      where: { id }
    });

    if (!board) {
      res.status(404).json({ error: 'Board not found' });
      return;
    }

    if (board.ownerId !== userId) {
      res.status(403).json({ error: 'Only the owner can remove members' });
      return;
    }

    // Remove member
    await prisma.boardMember.delete({
      where: { id: memberId }
    });

    res.json({ message: 'Member removed successfully' });
  } catch (error) {
    console.error('Error removing board member:', error);
    res.status(500).json({ error: 'Failed to remove board member' });
  }
}

